"""布洛妮娅的嵌入服务。

活着的时候一直挂在后台,从 stdin 读一行 JSON、往 stdout 写一行 JSON。
模型只加载一次 —— 加载要 4 秒,不能每轮都付这个钱。

协议(一行一个 JSON):

    请求  {"id": 1, "texts": ["...", "..."]}
    响应  {"id": 1, "vectors": ["<base64 float32 小端>", ...]}
    出错  {"id": 1, "error": "..."}
    就绪  {"id": 0, "ready": true, "dim": 512}

为什么用 base64 而不是 JSON 数字数组:
512 维 float32 用 JSON 数字写要 6 KB 左右,base64 只要 2.7 KB,
而且不用解析成千上万个小数。

模型:BAAI/bge-small-zh-v1.5,24M 参数,512 维,CPU 单句约 13 ms。
判定和判重都靠它 —— 只做句向量,不做生成,不发任何网络请求。
"""

import base64
import json
import os
import sys


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else ""
    if not model_dir or not os.path.isdir(model_dir):
        out({"id": 0, "error": "model-dir-missing: " + str(model_dir)})
        return

    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except Exception as e:  # noqa: BLE001
        out({"id": 0, "error": "import: " + repr(e)[:300]})
        return

    try:
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        tokenizer = AutoTokenizer.from_pretrained(model_dir)
        model = AutoModel.from_pretrained(model_dir).eval()
    except Exception as e:  # noqa: BLE001
        out({"id": 0, "error": "load: " + repr(e)[:300]})
        return

    out({"id": 0, "ready": True, "dim": int(model.config.hidden_size)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue

        req_id = req.get("id", 0)
        texts = req.get("texts") or []
        if not texts:
            out({"id": req_id, "vectors": []})
            continue

        try:
            with torch.no_grad():
                batch = tokenizer(
                    texts,
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors="pt",
                )
                hidden = model(**batch).last_hidden_state
                # 平均池化 + L2 归一化(bge 的标准做法)
                mask = batch["attention_mask"].unsqueeze(-1).float()
                pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
            vectors = [
                base64.b64encode(v.numpy().astype("float32").tobytes()).decode("ascii")
                for v in pooled
            ]
            out({"id": req_id, "vectors": vectors})
        except Exception as e:  # noqa: BLE001
            out({"id": req_id, "error": repr(e)[:300]})


if __name__ == "__main__":
    main()
