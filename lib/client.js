/**
 * 页面这边只做一件事:host 建完 detail / presence 会话,就跳过去。
 *
 * 为什么不是推送:host 和页面之间没有现成的反向通道,life 是纯 host 插件。
 * 加一条 GET /dsh-life/jump 让页面自己取,比接一套事件流省事得多,
 * 取到即清,两个客户端实例同时轮询也只会跳一次。
 *
 * 为什么不用 ctx.uiWorkspace 之外的东西:客户端切会话的公开入口只有它
 * (DSH 自己「分支会话」用的也是 openSession)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-life',
  factory() {
    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        let alive = true

        const poll = async () => {
          if (!alive) return
          try {
            const r = await fetch('/dsh-life/jump', { cache: 'no-store' })
            if (!r.ok) return
            const j = await r.json()
            if (j && typeof j.sessionId === 'string' && j.sessionId) {
              try {
                ctx.uiWorkspace.openSession(j.sessionId)
              } catch {
                /* 会话还没进列表之类的,下一轮再取 */
              }
            }
          } catch {
            /* 拿不到就等下一轮,不报错 */
          }
        }

        const timer = setInterval(poll, 1200)
        if (typeof timer.unref === 'function') timer.unref()

        return () => {
          alive = false
          clearInterval(timer)
        }
      },
    }
  },
})
