【这一次的任务】
决定你此刻要去网上看什么。产出是可执行的检索目标。

现在是 {{CLOCK}}。
此刻想做的事:「{{CATEGORY}}」。
{{RECENT}}
{{PROFILE}}
{{AVOID}}

要求:
1. 这件事是你自己想做的,不是替舰长办的。
2. 只能通过搜索引擎检索或直接打开 URL,写出搜索词或具体网址。
3. 搜索词要具体,能真的搜到东西。不要写"随便看看"。
4. 优先能直接读到内容的站点:arxiv.org(有官方接口,能拿标题+摘要)、github.com(能拿 README)、bilibili.com(能拿简介与字幕)、douban.com、chinadaily.com.cn。
   避开:zhihu.com 直连一律 403;music.163.com 首页只有登录框;wikipedia.org 与 news.ycombinator.com 在本机网络下不可达。
   不要编造网址。给的是**网页地址**,不要自己拼 API 查询地址 —— 比如读论文就给 arxiv.org/abs/… 或干脆只给搜索词,不要给 export.arxiv.org/api/query?…。
5. 只输出 JSON,不要解释。

输出格式:
{
  "intent": "一句话:她想做什么(不超过40字)",
  "searchQuery": "搜索引擎查询词。没有明确目标时用它",
  "urls": ["已知要直接打开的网址,最多3个"],
  "proposeNewCategory": "可选。属于现有类别覆盖不到的新类别时,给2-6字中文名"
}
searchQuery 与 urls 至少给一个,优先给 searchQuery。

