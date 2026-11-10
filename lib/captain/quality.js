/**
 * 记忆的质量闸。
 *
 * 存在的理由:库里有几条根本不该在的记录 ——
 *
 *   「有问题。1."听到了。(ᗜ ˰ ᗜ) 重装小兔的拾音器一直开着……」  ← 退化成原话,还混进了布洛妮娅自己的语气
 *   「舰长继续为桌面」                                          ← 半句话
 *
 * 这两条不是模型写得差,是**根本没走模型**:压缩失败的时候,代码直接把
 * 舰长的原话截断 60 个字存进去当记忆。
 *
 * 那等于把设计原则最想避免的东西写了进去 ——
 * 舰长当初要求"用你的话概括,不要照抄原话",就是为了不让啰嗦占权重。
 * 退化成原话,恰好是最该避免的那种。
 *
 * 所以现在:**压缩失败就不入库**。
 * 宁可不记,也不要把垃圾写进去 —— 库里多一行垃圾,以后每次挂载都要背着它。
 */

/**
 * 工作/项目/技术相关的词。
 *
 * 舰长的要求:"工作相关的全不记,只留状态、情绪、偏好、经历、人际关系。"
 *
 * 这道闸只作用在**压缩出来的概括**上,不作用在舰长的原话上 ——
 * 原话里几乎总有工作内容(那正是他来找布洛妮娅的原因),
 * 要是在原话上卡,这条链就什么都记不下来了。
 */
const WORK_WORDS = [
  // 具体项目/赛事
  'RoboMaster', '装甲板', '赛制', '工业相机', '相机', '视觉', '比赛', '实测', '测评',
  // 通用工作词汇
  '项目', '方案', '指标', '论文', '实验', '训练', '推理', '模型', '算法', '代码', '程序',
  '脚本', '接口', '参数', '配置', '部署', '仓库', '提交', '重构', '调试', '文档', '数据库',
  '插件', '功能', '逻辑', '语音播报', '判定顺序', '技术', '开发', '实现', '版本',
]

/**
 * 这句话是不是在工作/项目范围内。
 *
 * 返回命中的词,方便调试和日志。
 */
export function isWorkRelated(text) {
  const s = String(text ?? '')
  const hits = WORK_WORDS.filter((w) => s.includes(w))
  return { work: hits.length > 0, hits }
}

/**
 * 这句话能不能当"关于舰长的记忆"存下来。
 *
 * 判据都来自实际见过的坏例子,不是凭空想的:
 *   - 太短:「舰长继续为桌面」这种半句话,信息量约等于零
 *   - 不是第三人称:模型偶尔会写成"我注意到……"
 *   - 带语气标记:「(ᗜ ˰ ᗜ)」是布洛妮娅自己的,不是舰长的事
 *   - 像代码:混进来的技术片段
 *   - 工作相关:舰长说了"工作相关的全不记"
 */
export function looksLikeFact(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()

  if (s.length < 12) return { ok: false, why: 'too-short' }
  if (!/^舰长/.test(s)) return { ok: false, why: 'not-third-person' }
  if (/ᗜ|˰/.test(s)) return { ok: false, why: 'has-persona-marker' }
  if (/[{}<>]|```|\bfunction\b|\bconst\b|\bimport\b|=>|::/.test(s)) {
    return { ok: false, why: 'looks-like-code' }
  }
  const w = isWorkRelated(s)
  if (w.work) return { ok: false, why: 'work-related:' + w.hits.slice(0, 3).join('/') }
  return { ok: true }
}

/**
 * 从一句完整的话里取出短标签。
 *
 * 为什么要单独一个 title:挂载的时候要一眼扫过去,
 * 7 条记忆排在一起,每条都读到 60 个字就太密了。
 *
 * 切法:第一句里第一个逗号之前的那一截 —— 那一截通常就是"谁在做什么",
 * 正好当标签。剩下半句留在 content 里当细节。
 */
export function shortTitle(text, max = 18) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''

  // 第一句
  const sentence = (s.split(/[。!?；]/)[0] ?? s).trim()
  // 那一句里的第一个逗号之前
  const clause = (sentence.split(/[，,、]/)[0] ?? sentence).trim()
  if (!clause) return s.slice(0, max)
  return clause.length > max ? clause.slice(0, max) + '…' : clause
}

/**
 * 正文去掉和标签重复的开头。
 *
 * 标签已经是"舰长正推进RoboMaster视觉项目"了,正文再开头一遍就是重复 ——
 * 挂载的时候两行加起来白占预算。
 */
export function detailWithoutHead(body, head) {
  const b = String(body ?? '').replace(/\s+/g, ' ').trim()
  const h = String(head ?? '').trim()
  if (!h || !b.startsWith(h)) return b
  const rest = b.slice(h.length).replace(/^[，,、:：。\s]+/, '').trim()
  return rest
}
