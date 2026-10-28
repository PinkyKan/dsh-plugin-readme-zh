/**
 * Client half of dsh-plugin-readme-zh.
 *
 * Adds a "中文说明" control to the head of every installed plugin's detail
 * page. The control opens a dialog that shows the plugin's long description
 * translated into Simplified Chinese, with live progress, cache statistics, a
 * force-retranslate action, and a "translate all installed plugins" action.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-readme-zh',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const BASE = '/api/plugin-readme-zh'

    /* ---------------------------------------------------------------- *
     * HTTP helpers
     * ---------------------------------------------------------------- */

    async function api(path, options) {
      const response = await fetch(BASE + path, options)
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`)
      }
      return body ?? {}
    }

    const STATUS_TEXT = {
      'unknown-bundle': '未找到这个插件包',
      unavailable: '这个插件的文件不可用，无法读取说明',
      'no-document': '这个插件没有可读取的说明文档',
      'source-chinese': '原文已经是中文，无需翻译',
      idle: '准备翻译',
      running: '正在翻译',
      done: '翻译完成',
      error: '翻译失败',
    }

    function statusText(info) {
      if (info === null || info === undefined) return ''
      if (info.state === 'error' && typeof info.error === 'string' && info.error !== '') return info.error
      return STATUS_TEXT[info.state] ?? String(info.state ?? '')
    }

    function subjectName(subject) {
      if (subject === null || subject === undefined) return null
      if (subject.kind !== 'bundle' && subject.kind !== 'row') return null
      const pkg = subject.pkg
      if (pkg === null || pkg === undefined) return null
      if (pkg.availability === 'missing') return null
      if (typeof pkg.name !== 'string' || pkg.name === '') return null
      return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : undefined }
    }

    /* ---------------------------------------------------------------- *
     * Markdown rendering (React elements only; no innerHTML)
     * ---------------------------------------------------------------- */

    function sanitizeUrl(raw) {
      const url = String(raw ?? '').trim()
      if (/^(https?:\/\/|mailto:)/i.test(url)) return url
      if (url.startsWith('#')) return url
      return undefined
    }

    function stripHtmlTags(text) {
      return text.replace(/<\/?[a-zA-Z][^>]*>/g, '')
    }

    function renderInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(!?\[[^\]]*\]\([^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(stripHtmlTags(text.slice(last, match.index)))
        const token = match[0]
        const key = `${keyPrefix}-i${index}`
        index += 1
        if (token.startsWith('![')) {
          const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token)
          if (image !== null && image[1].trim() !== '') {
            nodes.push(h('span', { key, className: 'prz-image-alt' }, image[1]))
          }
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'prz-inline-code' }, token.slice(1, -1)))
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, stripHtmlTags(token.slice(2, -2))))
        } else if (token.startsWith('*')) {
          nodes.push(h('em', { key }, stripHtmlTags(token.slice(1, -1))))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          const url = link === null ? undefined : sanitizeUrl(link[2])
          if (link === null) nodes.push(token)
          else if (url === undefined) nodes.push(stripHtmlTags(link[1]))
          else {
            nodes.push(h('a', {
              key,
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, stripHtmlTags(link[1])))
          }
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(stripHtmlTags(text.slice(last)))
      return nodes
    }

    function isBlockStart(line) {
      return /^\s*(`{3,}|~{3,})/.test(line)
        || /^#{1,6}\s+/.test(line)
        || /^\s*>/.test(line)
        || /^\s*([-*+]|\d+[.)])\s+/.test(line)
        || /^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)
        || /^\s*\|.*\|\s*$/.test(line)
    }

    function renderMarkdown(markdown) {
      const lines = String(markdown).split('\n')
      const blocks = []
      let key = 0
      const push = (element) => {
        blocks.push(element)
      }
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (line.trim() === '') {
          index += 1
          continue
        }
        const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line)
        if (fence !== null) {
          const marker = fence[1][0]
          const close = new RegExp(`^\\s*${marker}{3,}\\s*$`)
          const code = []
          index += 1
          while (index < lines.length && !close.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          push(h('pre', { key: `b${key++}`, className: 'prz-pre' }, h('code', null, code.join('\n'))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = Math.min(6, heading[1].length)
          push(h(`h${level}`, { key: `b${key++}`, className: `prz-h prz-h${level}` }, renderInline(heading[2], `h${key}`)))
          index += 1
          continue
        }
        if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
          push(h('hr', { key: `b${key++}`, className: 'prz-hr' }))
          index += 1
          continue
        }
        if (/^\s*>/.test(line)) {
          const quote = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          push(h('blockquote', { key: `b${key++}`, className: 'prz-quote' }, renderInline(quote.join(' '), `q${key}`)))
          continue
        }
        if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(lines[index + 1])) {
          const header = lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
          index += 2
          const rows = []
          while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
            rows.push(lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
            index += 1
          }
          push(h('div', { key: `b${key++}`, className: 'prz-table-wrap' },
            h('table', { className: 'prz-table' },
              h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell, `th${cellIndex}`))))),
              h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
                row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell, `td${rowIndex}-${cellIndex}`))))))))) 
          continue
        }
        const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
        if (listMatch !== null) {
          const ordered = /\d/.test(listMatch[1])
          const items = []
          while (index < lines.length) {
            const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
            if (item === null) break
            items.push(item[2])
            index += 1
            while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !isBlockStart(lines[index])) {
              items[items.length - 1] += ` ${lines[index].trim()}`
              index += 1
            }
          }
          push(h(ordered ? 'ol' : 'ul', { key: `b${key++}`, className: 'prz-list' },
            items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item, `li${itemIndex}`)))))
          continue
        }
        const paragraph = []
        while (index < lines.length && lines[index].trim() !== '' && (paragraph.length === 0 || !isBlockStart(lines[index]))) {
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length === 0) {
          index += 1
          continue
        }
        const text = paragraph.join(' ').trim()
        if (text !== '') push(h('p', { key: `b${key++}`, className: 'prz-p' }, renderInline(text, `p${key}`)))
      }
      return blocks
    }

    /* ---------------------------------------------------------------- *
     * Styles
     * ---------------------------------------------------------------- */

    const CSS = `
      .prz-action { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d6d6d6); background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; }
      .prz-action:hover { background: var(--dsw-alias-bg-layer-2, #f2f2f2); }
      .prz-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; }
      .prz-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #247bbf); opacity: .55; }
      .prz-overlay { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; padding: 32px; background: rgba(0, 0, 0, .38); }
      .prz-dialog { display: flex; flex-direction: column; width: min(920px, 100%); max-height: min(86vh, 960px); border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e2e2e2); background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: 0 24px 64px rgba(0, 0, 0, .28); overflow: hidden; }
      .prz-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e2e2); }
      .prz-head-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
      .prz-title { margin: 0; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .prz-version { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary, #6b6b6b); border: 1px solid var(--dsw-alias-border-l1, #e2e2e2); border-radius: 999px; padding: 1px 8px; }
      .prz-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .prz-close { flex: none; width: 28px; height: 28px; border-radius: 6px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b); font-size: 18px; line-height: 1; cursor: pointer; }
      .prz-close:hover { background: var(--dsw-alias-bg-layer-2, #f2f2f2); color: var(--dsw-alias-label-primary, #1f1f1f); }
      .prz-body { flex: 1; overflow-y: auto; padding: 16px 22px 22px; font-size: 13.5px; line-height: 1.7; }
      .prz-status { display: flex; flex-direction: column; gap: 10px; padding: 18px 0; }
      .prz-status-line { font-size: 13px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .prz-status-line strong { color: var(--dsw-alias-label-primary, #1f1f1f); }
      .prz-progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #f2f2f2); overflow: hidden; }
      .prz-progress-bar { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary, #247bbf); transition: width .3s ease; }
      .prz-error { margin: 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary, #d33); color: var(--dsw-alias-state-error-primary, #d33); background: var(--dsw-alias-bg-layer-1, #fafafa); font-size: 13px; }
      .prz-notice { margin: 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, #e2e2e2); background: var(--dsw-alias-bg-layer-1, #fafafa); font-size: 13px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .prz-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid var(--dsw-alias-border-l1, #e2e2e2); background: var(--dsw-alias-bg-layer-1, #fafafa); }
      .prz-foot-spacer { flex: 1; }
      .prz-button { height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #d6d6d6); background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; cursor: pointer; }
      .prz-button:hover { background: var(--dsw-alias-bg-layer-2, #f2f2f2); }
      .prz-button:disabled { opacity: .55; cursor: default; }
      .prz-button-primary { border-color: var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-brand-primary, #247bbf); }
      .prz-foot-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .prz-prefetch { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .prz-h { margin: 18px 0 8px; line-height: 1.4; }
      .prz-h1 { font-size: 1.55em; font-weight: 700; margin-top: 0; }
      .prz-h2 { font-size: 1.3em; font-weight: 650; padding-bottom: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e2e2); }
      .prz-h3 { font-size: 1.12em; font-weight: 600; }
      .prz-h4, .prz-h5, .prz-h6 { font-size: 1em; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .prz-p { margin: 0 0 10px; }
      .prz-list { margin: 0 0 10px; padding-left: 22px; }
      .prz-list li { margin-bottom: 4px; }
      .prz-pre { margin: 0 0 12px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, #e2e2e2); background: var(--dsw-alias-bg-layer-2, #f2f2f2); overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
      .prz-pre code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; }
      .prz-inline-code { padding: 1px 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #f2f2f2); font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; font-size: .9em; }
      .prz-quote { margin: 0 0 10px; padding: 4px 12px; border-left: 3px solid var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-label-secondary, #6b6b6b); background: var(--dsw-alias-bg-layer-1, #fafafa); }
      .prz-hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1, #e2e2e2); margin: 18px 0; }
      .prz-table-wrap { overflow-x: auto; margin: 0 0 12px; }
      .prz-table { border-collapse: collapse; width: 100%; font-size: .92em; }
      .prz-table th, .prz-table td { border: 1px solid var(--dsw-alias-border-l1, #e2e2e2); padding: 6px 10px; text-align: left; vertical-align: top; }
      .prz-table th { background: var(--dsw-alias-bg-layer-2, #f2f2f2); font-weight: 600; }
      .prz-image-alt { color: var(--dsw-alias-label-secondary, #6b6b6b); font-style: italic; }
      .prz-body a { color: var(--dsw-alias-brand-primary, #247bbf); text-decoration: none; }
      .prz-body a:hover { text-decoration: underline; }
    `

    /* ---------------------------------------------------------------- *
     * Dialog
     * ---------------------------------------------------------------- */

    function TranslateDialog({ name, version, onClose }) {
      const [info, setInfo] = useState(null)
      const [markdown, setMarkdown] = useState(null)
      const [stats, setStats] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(true)
      const [copied, setCopied] = useState(false)
      const [prefetch, setPrefetch] = useState(null)

      const aliveRef = useRef(true)
      const pollRef = useRef(null)
      const prefetchRef = useRef(null)
      const closeRef = useRef(null)
      const previousFocusRef = useRef(null)

      const encoded = encodeURIComponent(name)

      const loadJob = useCallback(async () => {
        const job = await api(`/job?name=${encoded}`)
        if (!aliveRef.current) return
        setInfo(job)
        if (job.state === 'done' && typeof job.markdown === 'string') {
          setMarkdown(job.markdown)
          setStats(job.stats ?? null)
          setError(null)
          setBusy(false)
          return
        }
        if (job.state === 'running' || job.state === 'queued') {
          setBusy(true)
          pollRef.current = setTimeout(() => { void loadJob() }, 1100)
          return
        }
        if (job.state === 'error') {
          setError(job.error ?? '翻译失败')
          setBusy(false)
          return
        }
        setBusy(false)
      }, [encoded])

      const start = useCallback(async (force) => {
        setBusy(true)
        setError(null)
        const started = await api(`/start?name=${encoded}${force ? '&force=1' : ''}`, { method: 'POST' })
        if (!aliveRef.current) return
        setInfo(started)
        if (started.state === 'done') {
          await loadJob()
          return
        }
        if (started.state === 'running' || started.state === 'queued') {
          pollRef.current = setTimeout(() => { void loadJob() }, 900)
          return
        }
        if (started.state === 'error') {
          setError(started.error ?? '翻译失败')
          setBusy(false)
          return
        }
        setBusy(false)
      }, [encoded, loadJob])

      const begin = useCallback(async () => {
        try {
          const status = await api(`/status?name=${encoded}`)
          if (!aliveRef.current) return
          setInfo(status)
          if (status.state === 'done') {
            await loadJob()
            return
          }
          if (status.state === 'idle') {
            await start(false)
            return
          }
          if (status.state === 'running') {
            setBusy(true)
            pollRef.current = setTimeout(() => { void loadJob() }, 900)
            return
          }
          setBusy(false)
        } catch (failure) {
          if (!aliveRef.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
          setBusy(false)
        }
      }, [encoded, loadJob, start])

      useEffect(() => {
        aliveRef.current = true
        previousFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null
        closeRef.current?.focus?.()
        void begin()
        return () => {
          aliveRef.current = false
          if (pollRef.current !== null) clearTimeout(pollRef.current)
          if (prefetchRef.current !== null) clearTimeout(prefetchRef.current)
          const previous = previousFocusRef.current
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
        // The dialog is per bundle; a subject change remounts it via key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [onClose])

      const copy = async () => {
        if (typeof markdown !== 'string') return
        try {
          await navigator.clipboard.writeText(markdown)
          setCopied(true)
          setTimeout(() => { if (aliveRef.current) setCopied(false) }, 1500)
        } catch (failure) {
          setError(`复制失败：${failure instanceof Error ? failure.message : String(failure)}`)
        }
      }

      const pollPrefetch = useCallback(async () => {
        try {
          const state = await api('/prefetch')
          if (!aliveRef.current) return
          setPrefetch(state)
          if (state.state === 'running') prefetchRef.current = setTimeout(() => { void pollPrefetch() }, 1500)
        } catch {
          // Progress display only; a failure here must not disturb the dialog.
        }
      }, [])

      const translateAll = async () => {
        try {
          const state = await api('/prefetch', { method: 'POST' })
          if (!aliveRef.current) return
          setPrefetch(state)
          if (state.state === 'running') prefetchRef.current = setTimeout(() => { void pollPrefetch() }, 800)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const state = info?.state
      const total = info?.total ?? 0
      const done = info?.done ?? 0
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
      const titleStatus = markdown !== null ? '已翻译' : statusText(info)
      // Live counters: while a job runs these are its real-time counts; when
      // it has settled they reflect the current cache state of the document,
      // so a fully cached document reads "复用 N / 新译 0" instead of the
      // stale numbers of an older run.
      const isRunning = state === 'running' || state === 'queued'
      let liveReused
      let liveTranslated
      if (isRunning) {
        liveReused = info?.reused ?? 0
        liveTranslated = info?.translated ?? 0
      } else if (info?.cache?.state === 'idle') {
        liveReused = info.cache.reusable ?? 0
        liveTranslated = Math.max(0, (info.cache.total ?? 0) - (info.cache.reusable ?? 0))
      } else if (info?.cache?.state === 'done') {
        liveReused = info.cache.total ?? 0
        liveTranslated = 0
      } else {
        liveReused = stats?.reused ?? 0
        liveTranslated = stats?.translated ?? 0
      }
      const cacheBadge = isRunning || markdown !== null || (info?.cache !== undefined)
        ? `复用 ${liveReused} 段 / 新译 ${liveTranslated} 段`
        : null

      return ReactDOM.createPortal(
        h('div', {
          className: 'prz-overlay',
          onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
        },
          h('style', null, CSS),
          h('div', {
            className: 'prz-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': `中文说明：${name}`,
          },
            h('div', { className: 'prz-head' },
              h('div', { className: 'prz-head-main' },
                h('h2', { className: 'prz-title' },
                  '中文说明',
                  typeof version === 'string' && version !== '' ? h('span', { className: 'prz-version' }, version) : null,
                  cacheBadge !== null
                    ? h('span', { className: 'prz-version' }, cacheBadge)
                    : null),
                h('p', { className: 'prz-sub' }, info?.path !== undefined ? `${name} · ${info.path}` : name)),
              h('button', {
                ref: closeRef,
                type: 'button',
                className: 'prz-close',
                'aria-label': '关闭',
                onClick: onClose,
              }, '×')),

            h('div', { className: 'prz-body' },
              markdown !== null ? renderMarkdown(markdown) : null,
              markdown === null && busy
                ? h('div', { className: 'prz-status' },
                  h('div', { className: 'prz-status-line' },
                    total > 0
                      ? h(React.Fragment, null, '正在翻译 ', h('strong', null, `${done} / ${total}`), ' 段…')
                      : '正在读取插件说明…'),
                  total > 0
                    ? h('div', { className: 'prz-progress' }, h('div', { className: 'prz-progress-bar', style: { width: `${percent}%` } }))
                    : null,
                  h('div', { className: 'prz-foot-note' }, '首次翻译需要调用模型；结果按段落缓存，插件更新时只会重译改动过的段落。'))
                : null,
              markdown === null && busy === false && error !== null
                ? h('div', null,
                  h('div', { className: 'prz-error' }, error),
                  h('button', { type: 'button', className: 'prz-button prz-button-primary', onClick: () => { void start(false) } }, '重试'))
                : null,
              markdown === null && busy === false && error === null
                ? h('div', { className: 'prz-notice' }, statusText(info) || '暂时无法显示中文说明')
                : null),

            h('div', { className: 'prz-foot' },
              h('button', {
                type: 'button',
                className: 'prz-button',
                disabled: typeof markdown !== 'string',
                onClick: () => { void copy() },
              }, copied ? '已复制' : '复制中文'),
              h('button', {
                type: 'button',
                className: 'prz-button',
                disabled: busy === true,
                onClick: () => { setMarkdown(null); setStats(null); void start(true) },
              }, '重新翻译'),
              h('button', {
                type: 'button',
                className: 'prz-button',
                disabled: prefetch?.state === 'running',
                onClick: () => { void translateAll() },
              }, '翻译全部已安装插件'),
              prefetch?.state === 'running'
                ? h('span', { className: 'prz-prefetch' }, `全部翻译 ${prefetch.done ?? 0} / ${prefetch.total ?? 0}${prefetch.current !== null ? ` · ${prefetch.current}` : ''}`)
                : prefetch?.state === 'done'
                  ? h('span', { className: 'prz-prefetch' }, `全部翻译完成${(prefetch.failed?.length ?? 0) > 0 ? `（${prefetch.failed.length} 个失败）` : ''}`)
                  : null,
              h('span', { className: 'prz-foot-spacer' }),
              h('span', { className: 'prz-foot-note' }, titleStatus)))),
        document.body)
    }

    /* ---------------------------------------------------------------- *
     * Detail-page action
     * ---------------------------------------------------------------- */

    function TranslateAction({ subject }) {
      const target = subjectName(subject)
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState(null)

      const name = target?.name

      useEffect(() => {
        if (name === undefined) return undefined
        let alive = true
        void api(`/status?name=${encodeURIComponent(name)}`)
          .then((value) => { if (alive) setStatus(value) })
          .catch(() => { if (alive) setStatus(null) })
        return () => { alive = false }
      }, [name])

      if (target === null) return null
      if (status !== null && (status.state === 'source-chinese' || status.state === 'no-document'
        || status.state === 'unavailable' || status.state === 'unknown-bundle')) {
        return null
      }

      const suffix = status?.state === 'done' ? ' · 已缓存'
        : status?.state === 'running' ? ' · 翻译中'
          : ''
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'prz-action',
          onClick: () => setOpen(true),
          title: '查看这个插件说明的中文翻译（结果会缓存）',
        },
          h('span', { className: 'prz-dot', 'aria-hidden': true }),
          `中文说明${suffix}`),
        open
          ? h(TranslateDialog, {
            key: target.name,
            name: target.name,
            version: target.version,
            onClose: () => setOpen(false),
          })
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'plugin-readme-zh',
          order: 30,
        }, TranslateAction))
      },
    }
  },
})