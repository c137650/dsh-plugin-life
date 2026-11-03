/**
 * 规则闸门。
 *
 * 舰长要的是"混合":规则做闸门,embedding 做判重和提及检测。
 *
 * 这里只回答一个问题:**这句话值不值得进候选库**。
 * 它不回答"是不是和已有记录重复"(那是向量的活),
 * 也不回答"以后还会不会被提到"(那是热度的活)。
 *
 * 设计取向:宁可错收,不可漏放。
 * 因为收错了的代价只是库里多一行、然后自然沉底;
 * 漏放的代价是这件事永远不会被记住。
 *
 * 词表可以被舰长改:数据目录下的 captain_rules.json
 * ({"plan": [...], "emotion": [...], ...})会覆盖同名的默认词表。
 */

import { existsSync, readFileSync } from 'node:fs'

/**
 * 默认词表。
 *
 * 每一类都是一个方向:命中越多,越像是"关于舰长自己的事"。
 */
const DEFAULT_WORDS = {
  // 时间、计划、行程 —— 舰长在说"我要做什么"
  plan: [
    '明天', '后天', '下周', '下礼拜', '下个月', '周末', '今晚', '今天', '昨天', '昨晚',
    '刚才', '早上', '上午', '下午', '最近', '以后', '将来', '今年', '明年',
    '打算', '准备', '计划', '要去', '要出', '出差', '旅行', '旅游', '出门',
    '考试', '考', '面试', '演讲', '开会', '会议', '生日', '搬家', '看病', '手术',
    '约好', '订了', '回老家', '回家', '值班', '加班', '请假', '放假', '假期',
  ],
  // 情绪和身体 —— 舰长在说自己的状态
  emotion: [
    '紧张', '焦虑', '压力', '烦', '累', '困', '失眠', '睡不着', '头疼', '头昏',
    '难受', '不舒服', '不开心', '难过', '生气', '害怕', '担心', '开心', '高兴',
    '舒服', '生病', '感冒', '发烧', '疼', '饿', '孤单', '孤独', '想哭', '崩溃',
    '沮丧', '低落', '兴奋', '激动', '心慌', 'emo',
  ],
  // 喜好、习惯、厌恶
  preference: [
    '喜欢', '讨厌', '不喜欢', '不想', '习惯', '每天', '总是', '老是', '从来不',
    '爱吃', '爱喝', '受不了', '沉迷', '上瘾', '戒掉', '想戒', '一直想',
  ],
  // 关系 —— 舰长在说和他有关的人,或者和布洛妮娅的关系
  relation: [
    '我妈', '我爸', '我家里', '我家人', '我妻子', '我丈夫', '朋友', '同事',
    '上司', '老板', '老师', '同学', '女朋友', '男朋友', '老婆', '老公', '孩子',
    '舰长', '我们', '陪我', '陪我',
  ],
}

/**
 * 反向标记 —— 这些词说明这是一条**任务指令**,不是关于舰长自己的事。
 *
 * 舰长的话:"如果把任务写进去了只会污染记忆。"
 */
const DEFAULT_TASK_WORDS = [
  '代码', '函数', '变量', '参数', '阈值', '配置', '数据库', '插件', '脚本',
  '接口', '日志', '文件', '目录', '部署', '编译', '报错', 'bug', '测试',
  '重启', '改一下', '改成', '修改', '删除', '安装', '运行', '跑一下',
  '检查一下', '试一下', '写一个', '加一个', '看一下', '实现', '重构',
  'bug', 'commit', 'merge', 'push',
]

const CATEGORY_NAMES = ['plan', 'emotion', 'preference', 'relation']

/** 第一人称。含"我们"——舰长和布洛妮娅一起做的事也算。 */
const FIRST_PERSON = /我|咱|俺/

/** 门槛:第一人称 2 分 + 每命中一类 2 分,反向每命中一个 -2 分。 */
const STORE_SCORE = 3

export function loadRules(dir) {
  let words = DEFAULT_WORDS
  let taskWords = DEFAULT_TASK_WORDS
  try {
    const file = dir + '\\captain_rules.json'
    if (existsSync(file)) {
      const custom = JSON.parse(readFileSync(file, 'utf8'))
      words = { ...DEFAULT_WORDS }
      for (const name of CATEGORY_NAMES) {
        if (Array.isArray(custom[name]) && custom[name].length) words[name] = custom[name]
      }
      if (Array.isArray(custom.task) && custom.task.length) taskWords = custom.task
    }
  } catch {
    /* 配置坏了就用默认,不能因此不加载插件 */
  }
  return { words, taskWords }
}

/**
 * 过闸门。
 *
 * 返回 { store, score, kinds }:
 *   store  要不要当候选入库
 *   score  分数(留给调试和日志)
 *   kinds  命中的类别(用来填库里的 kind 列)
 */
export function gate(text, rules) {
  if (typeof text !== 'string') return { store: false, score: 0, kinds: [] }
  const body = text.trim()
  // 太短的没有信息量;太长的多半是贴了一段日志或代码
  if (body.length < 6 || body.length > 600) return { store: false, score: -99, kinds: [] }

  const kinds = []
  let score = 0

  if (FIRST_PERSON.test(body)) score += 2

  for (const name of CATEGORY_NAMES) {
    const hits = rules.words[name].filter((w) => body.includes(w))
    if (hits.length) {
      kinds.push(name)
      score += 2
      if (hits.length >= 2) score += 1
    }
  }
  // 类别分封顶 6,免得一句话里堆几个词就无脑入库
  if (score > 8) score = 8

  let penalty = 0
  for (const w of rules.taskWords) {
    if (body.includes(w)) penalty += 2
    if (penalty >= 8) break
  }
  score -= penalty

  // 纯提问且没有命中任何"关于自己"的类别 —— 多半是在问系统
  if (!kinds.length && /[?？]\s*$/.test(body)) score -= 2

  return { store: score >= STORE_SCORE, score, kinds }
}

/** 这句话最像哪一类,用来填库里的 kind 列。 */
export function classify(text, rules) {
  const { kinds } = gate(text, rules)
  if (kinds.length) return kinds[0]
  return 'fact'
}
