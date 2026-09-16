window.__ModuleLoader__.load({
  id: 'dsh-git-vcs',
  factory: (require) => {
    /**
     * dsh-git-vcs —— 浏览器半区（跑在 dsh web 页面里）。
     *
     * 形态与官方「工作区文件」(dsh-client-ui-sidebar-files) 完全相同：注册一个**右侧栏 tab 类型**
     *   · 阶段一  ctx.sidebarRightTabs.register({ id, kind, title, guide })   ← 类型 + 引导页入口
     *   · 阶段二  slots.register({ name: 'sidebar.right.pane.tab', key: id })  ← 正文
     *   · 阶段三  slots.register({ name: 'sidebar.right.pane.tab.title', key: id }) ← chip 标题
     * 分栏 / 全屏 / 拖出浮窗由 dsh-client-ui-sidebar-right + dockkit 提供，本包不做任何布局工作。
     *
     * 运行时约束：只 require 平台模块表里的 specifier（这里只用 react）；产物是闭包工厂；
     * 组件收不到 ctx，host 调用经注册项 inject 工厂闭包捕获后注入；样式全内联（不写 document.head）。
     *
     * 性能约定（面板流畅度的关键，改这里前先读）：
     *   · 首次加载 / 每次刷新只发**一次** RPC：`repo/snapshot`（host 侧 6 个 git 探测并发）。
     *   · 写操作后同样只刷一次 snapshot，并把真实往返耗时显示在状态栏「上次操作 N ms」。
     *   · 提交树（Log）一次只拉 LOG_PAGE 条，滚到底再按 `skip` 续拉下一页，最多 LOG_MAX_ROWS 行；
     *     刷新按「已加载条数」一次拉回，滚到深处不会因为刷新缩回一页。
     *   · 所有等待都有可见文案（顶部进度条 + 页脚转圈文案 + 各分区占位），不留白屏。
     */
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    /** host 侧 RPC 通道（index.js 里 ctx.connection.rpc.handle 的同一个名字）。 */
    const CHANNEL = '/git-vcs'
    /** 包名：同时是 tab 类型的 id（正文与标题注册用同一个 key）。 */
    const PKG_ID = 'dsh-git-vcs'
    /** tab 类型判别符（引导页胶囊打开的就是它）。 */
    const KIND = 'git-vcs'

    /**
     * 提交树分页：一次 50 条，滚到底自动续拉；最多渲染 2000 行（涵盖所有分支的节点）。
     * 与 host 的 LOG_LIMIT_MAX 对应 —— 首屏 snapshot 与续拉 log 必须用同一个页大小。
     */
    const LOG_PAGE = 50
    const LOG_MAX_ROWS = 2000

    /* ------------------------------------------------------------------ 样式 */

    const BORDER = '1px solid rgba(128,128,128,0.22)'
    const MUTED = 'rgba(128,128,128,0.95)'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative', fontSize: '12px', lineHeight: 1.5 },
      busyBar: { flex: 'none', height: '2px', background: 'rgba(59,130,246,0.75)' },
      bar: { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 8px', borderBottom: BORDER, flexWrap: 'wrap', flex: 'none' },
      spacer: { flex: 1, minWidth: 0 },
      button: {
        font: 'inherit', fontSize: '12px', padding: '2px 8px', borderRadius: '6px', cursor: 'pointer',
        border: BORDER, background: 'transparent', color: 'inherit',
      },
      buttonPrimary: { border: '1px solid rgba(59,130,246,0.55)', background: 'rgba(59,130,246,0.14)' },
      buttonDanger: { border: '1px solid rgba(239,68,68,0.5)', background: 'rgba(239,68,68,0.12)' },
      buttonOff: { opacity: 0.45, cursor: 'default' },
      close: { width: '22px', height: '22px', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', lineHeight: 1, flex: 'none' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', font: 'inherit', fontSize: '12px',
        padding: '2px 8px', borderRadius: '999px', border: BORDER, background: 'rgba(128,128,128,0.08)',
        color: 'inherit', cursor: 'pointer',
      },
      input: {
        font: 'inherit', fontSize: '12px', flex: 1, minWidth: 0, padding: '3px 7px', borderRadius: '6px',
        border: BORDER, background: 'rgba(128,128,128,0.06)', color: 'inherit',
        /* 干掉浏览器默认那圈焦点高亮（深色主题下是黑的），焦点态自己画。 */
        outline: 'none',
      },
      /** 输入框获得焦点：蓝色描边 + 淡蓝底 + 外圈柔光（零构建下没有 :focus，用状态模拟）。 */
      inputFocus: {
        borderColor: 'rgba(59,130,246,0.75)', background: 'rgba(59,130,246,0.10)',
        boxShadow: '0 0 0 2px rgba(59,130,246,0.18)',
      },
      /** 复选框：让浏览器用它自带的勾选样式，但配色跟随主题蓝，且不带那圈黑色焦点框。 */
      checkbox: { accentColor: '#3b82f6', margin: '0 2px 0 0', cursor: 'pointer', outline: 'none', verticalAlign: 'middle' },
      tabs: { display: 'flex', gap: '2px', padding: '4px 6px 0', borderBottom: BORDER, flex: 'none', flexWrap: 'wrap' },
      tab: { font: 'inherit', fontSize: '12px', padding: '3px 10px', border: 0, background: 'transparent', color: MUTED, cursor: 'pointer', borderRadius: '6px 6px 0 0' },
      tabOn: { color: 'inherit', background: 'rgba(128,128,128,0.16)' },
      bodyCol: { flex: 1, minHeight: 0, overflow: 'auto' },
      /** 正常（有仓库）时的整块面板：空态与它二选一渲染，因此它必须自己吃掉剩余高度。 */
      paneCol: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      col: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' },
      /** Local Changes 与 Log 都用上下布局：列表在上、详情（差异 / 提交详情）在下。 */
      bodyStack: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      /** 底部详情面板：高度由顶边拖拽条控制（默认 300px，两个页面共用同一个高度状态）。 */
      detailBottom: {
        flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '80%',
        borderTop: BORDER, background: 'var(--dsw-alias-bg-layer-1)',
      },
      splitterY: { flex: 'none', height: '7px', cursor: 'row-resize', position: 'relative', touchAction: 'none' },
      splitterYOn: { background: 'rgba(59,130,246,0.35)' },
      splitterYBar: { position: 'absolute', left: '50%', top: '3px', width: '40px', height: '2px', marginLeft: '-20px', borderRadius: '2px', background: 'rgba(128,128,128,0.55)' },
      detailBody: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      detailSummary: { flex: 'none', maxHeight: '76px', overflow: 'auto', padding: '3px 8px', display: 'flex', flexDirection: 'column', gap: '2px' },
      /* 变更文件列表：自己占一小段并可滚动，高度随面板拖动变化。 */
      detailFiles: { flex: '0 1 auto', minHeight: '46px', maxHeight: '46%', overflow: 'auto' },
      detailFileRow: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' },
      detailFileRowOn: { background: 'rgba(59,130,246,0.18)' },
      detailDiff: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', borderTop: BORDER, position: 'relative' },
      head: { padding: '3px 8px', color: MUTED, background: 'rgba(128,128,128,0.08)', position: 'sticky', top: 0, zIndex: 1 },
      row: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap', minWidth: 0 },
      rowOn: { background: 'rgba(59,130,246,0.18)' },
      letter: { width: '12px', textAlign: 'center', fontFamily: MONO, fontWeight: 700, flex: 'none' },
      name: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      dir: { color: MUTED, flex: 'none' },
      pre: { margin: 0, fontFamily: MONO, fontSize: '11px', whiteSpace: 'pre-wrap', padding: '4px 8px' },
      /* 差异行：左侧固定行号槽 + 右侧代码。代码默认换行（长行走查不到右边、横向滚动时颜色也画不全）。 */
      lineRow: { display: 'flex', alignItems: 'flex-start', fontFamily: MONO, fontSize: '11px', lineHeight: '16px' },
      gutter: {
        flex: 'none', width: '42px', boxSizing: 'border-box', textAlign: 'right', padding: '0 6px 0 0',
        color: 'rgba(128,128,128,0.75)', userSelect: 'none', borderRight: BORDER,
      },
      lineText: { flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: '0 8px' },
      lineAdd: { background: 'rgba(34,197,94,0.14)' },
      lineDel: { background: 'rgba(239,68,68,0.14)' },
      lineHunk: { background: 'rgba(59,130,246,0.14)', color: MUTED },
      /** ↑/↓ 当前停留的改动块：**只把左侧行号槽**点亮，代码区保留红/绿底色不被冲淡。 */
      gutterFocus: { background: 'rgba(59,130,246,0.45)', color: '#fff', boxShadow: 'inset 2px 0 0 #3b82f6' },
      /* ---- Log：div 版表格（列宽可拖动，提交树列自适应不可拖；宽度状态在 GitBody 的 logWidths） ---- */
      thead: {
        display: 'flex', alignItems: 'stretch', position: 'sticky', top: 0, zIndex: 2, boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1)', borderBottom: BORDER, fontSize: '12px', color: MUTED,
      },
      th: {
        position: 'relative', padding: '4px 8px', whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', userSelect: 'none', boxSizing: 'border-box',
      },
      tr: { display: 'flex', alignItems: 'stretch', boxSizing: 'border-box', cursor: 'pointer' },
      rowHover: { background: 'rgba(128,128,128,0.13)' },
      td: { padding: '5px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', boxSizing: 'border-box' },
      resizer: { position: 'absolute', top: 0, right: 0, width: '9px', height: '100%', cursor: 'col-resize', zIndex: 4, touchAction: 'none' },
      resizerOn: { background: 'rgba(59,130,246,0.35)' },
      resizerBar: { position: 'absolute', top: '22%', bottom: '22%', right: '1px', width: '1px', background: 'rgba(128,128,128,0.5)' },
      tdGraph: { display: 'flex', alignItems: 'stretch', gap: '4px', padding: '0 6px 0 0', boxSizing: 'border-box' },
      /** 泳道区：宽度 = 泳道数 × LANE_GAP，高度由 flex stretch 撑开（连线用百分比坐标画在里面）。 */
      laneBox: { position: 'relative', flex: 'none', alignSelf: 'stretch' },
      /**
       * 斜线层：绝对铺满泳道区，viewBox 纵向固定 0–100 再靠 `preserveAspectRatio="none"` 映射到行高，
       * 于是「半行」永远是 y=50、行高随标签换行变化也不用重新测量；
       * `vector-effect: non-scaling-stroke` 保证纵向拉伸不会把 2px 线画粗。
       *
       * **宽高必须显式写 100%**：`<svg>` 是 replaced element，只给 `top/left/right/bottom` 时
       * 高度是 auto，浏览器会按 viewBox 的固有比例算出高度（28:100 → 100px 高），斜线于是被放大成
       * 三行多、落到下面几行去（真机就是这样错位的）。显式 100% 后高度才真正等于行高。
       */
      laneLines: {
        position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
        display: 'block', overflow: 'visible',
      },
      /**
       * 连线基样式：竖直段用 div 画（能用 `calc(50% ± 半径)` 精确止于圆环外沿），left 由泳道下标算。
       */
      graphLine: { position: 'absolute', left: 0, width: '2px' },
      /**
       * 圆点：用 SVG 画的真圆（CSS 小圆环在非整数行高下会被栅格化出棱角），
       * 水平居中在泳道上、垂直居中于本行；外沿半径 = NODE_RADIUS，正好接住上下两段连线。
       */
      node: { position: 'absolute', top: '50%', marginTop: '-6px', display: 'block', lineHeight: 0 },
      chips: {
        display: 'flex', flex: 1, minWidth: 0, gap: '3px', flexWrap: 'wrap', overflow: 'hidden',
        alignItems: 'center', alignContent: 'center', paddingLeft: '2px',
      },
      chipBranch: { flex: 'none', fontSize: '10px', lineHeight: '15px', padding: '0 5px', borderRadius: '999px', border: '1px solid currentColor', whiteSpace: 'nowrap' },
      chipHead: { fontWeight: 700 },
      hashLink: { fontFamily: MONO, fontSize: '11px', color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: '2px' },
      placeholder: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', color: MUTED, fontSize: '12px', padding: '14px' },
      /* 未初始化仓库的空态：整块居中（不是列表里的占位条），点按钮就 git init。 */
      noRepo: {
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '10px', padding: '24px 20px', textAlign: 'center', overflow: 'auto',
      },
      noRepoIcon: { color: 'rgba(128,128,128,0.65)', lineHeight: 0, marginBottom: '2px' },
      noRepoTitle: { fontSize: '13px', fontWeight: 600 },
      noRepoPath: { fontFamily: MONO, fontSize: '11px', color: MUTED, maxWidth: '100%', wordBreak: 'break-all' },
      noRepoHint: { fontSize: '11px', color: MUTED, maxWidth: '300px', lineHeight: '17px' },
      buttonBig: { padding: '5px 14px', fontSize: '12px' },
      foot: { flex: 'none', borderTop: BORDER, padding: '3px 8px', color: MUTED, fontSize: '11px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      /* 提交勾选框：零构建下自己画，省得被浏览器默认样式带偏（第二部分要加"部分选中"态）。 */
      check: {
        flex: 'none', width: '14px', height: '14px', boxSizing: 'border-box', borderRadius: '3px',
        border: '1px solid rgba(128,128,128,0.65)', background: 'rgba(128,128,128,0.10)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', lineHeight: 1,
        cursor: 'pointer', userSelect: 'none', color: 'transparent',
      },
      checkOn: { background: 'rgba(59,130,246,0.95)', borderColor: 'rgba(59,130,246,0.95)', color: '#fff' },
      /* 未勾选态只把 ✓ 藏起来，方框与淡底保留：否则 13px 的 22% 透明描边在面板上几乎看不见。 */
      checkOff: { color: 'transparent' },
      checkDim: { opacity: 0.4, cursor: 'default' },
      /* 提示条：绝对定位浮在面板右下角，**不参与流式布局**（出现/消失都不会顶动高度，因此不会抖）。 */
      toast: {
        position: 'absolute', bottom: '8px', right: '8px', zIndex: 20, maxWidth: '280px', boxSizing: 'border-box',
        padding: '5px 10px', borderRadius: '8px', fontSize: '11px', lineHeight: '16px', wordBreak: 'break-all',
        background: 'rgba(22,163,74,0.95)', color: '#fff', boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
        pointerEvents: 'none',
      },
      toastBad: { background: 'rgba(220,38,38,0.95)' },
      /* 提交行右键菜单：绝对定位挂在面板根上（不在滚动容器里，避免被裁），支持多级子菜单。 */
      menu: {
        position: 'absolute', minWidth: '196px', maxWidth: '280px', zIndex: 40, padding: '4px 0',
        border: BORDER, borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)', fontSize: '12px',
      },
      menuGroup: { padding: '3px 10px 1px', color: MUTED, fontSize: '10px', letterSpacing: '0.04em' },
      menuSep: { height: '1px', margin: '4px 0', background: 'rgba(128,128,128,0.22)' },
      menuItem: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' },
      menuItemOn: { background: 'rgba(59,130,246,0.18)' },
      menuItemOff: { opacity: 0.45, cursor: 'default' },
      menuItemDanger: { color: '#ef4444' },
      menuHint: { marginLeft: 'auto', color: MUTED, fontSize: '10px' },
      menuArrow: { marginLeft: 'auto', color: MUTED, flex: 'none' },
      commit: { flex: 'none', borderTop: BORDER, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '5px' },
      area: {
        font: 'inherit', fontSize: '12px', width: '100%', minHeight: '48px', resize: 'vertical', boxSizing: 'border-box',
        padding: '5px 7px', borderRadius: '6px', border: BORDER, background: 'rgba(128,128,128,0.06)', color: 'inherit',
        outline: 'none', lineHeight: 1.5,
      },
      confirm: { flex: 'none', borderTop: BORDER, padding: '6px 8px', background: 'rgba(239,68,68,0.1)', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      hline: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      meta: { color: MUTED, fontFamily: MONO, fontSize: '11px' },
      remoteRow: { display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '5px 8px', whiteSpace: 'normal' },
      remoteCol: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      wrap: { wordBreak: 'break-all' },
      /**
       * tab chip 标题：单行不折行，并**预留右侧 30px 给关闭按钮**。
       *
       * dockkit 的 chip（._tab）在 hover / 选中时把关闭按钮绝对定位在 `<chip 右缘 - 24px>` 处，
       * 同时对标题容器（._tabTitle）加 `mask-image: linear-gradient(to right, black calc(100% - 30px), transparent calc(100% - 14px))`
       * —— 也就是**用渐隐吃掉标题尾部**来给按钮让位。我们如果不在自己这层留出这段内边距，
       * 渐隐区正好压住 "版本管理" 的最后一个字（选中时看起来像被 × 覆盖）。
       * 预留 30px 后渐隐落在空白上，文字保持清晰，chip 也相应变宽。
       * 数值：图标 14 + gap 5 + "版本管理"（13px CJK ≈ 52px）= 71px 内容；预留 32px 后
       * 渐变起点在 72px（= 104 - 32），正好在内容之后，留了几像素余量。
       */
      title: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap', flex: 'none',
        minWidth: '104px', paddingRight: '32px', boxSizing: 'border-box', overflow: 'hidden',
      },
    }

    /** Log 列宽上下限（px）：有表项 = 可拖动；graph 不在表里，宽度自适应且不可拖。 */
    const LOG_LIMITS = { date: [92, 360], message: [120, 900], author: [60, 280], commit: [64, 220] }

    /** 提交树的圆点半径（px）：连线两段正好止于圆环外沿，圆点内部不画线。 */
    const NODE_RADIUS = 5
    /** SVG circle 的 r：配 2px 描边，外沿正好 NODE_RADIUS。 */
    const NODE_R = 4
    /**
     * 泳道间距（px）：相邻两条分支泳道的中心距离。斜线要跨 LANE_GAP 横向位移，
     * 太小会看不清分叉、太大又浪费宽度，14px 在 12px 字号下正合适。
     */
    const LANE_GAP = 14
    /**
     * 圆环外沿在「斜线层」viewBox 纵向 0–100 坐标里的偏移量（≈ 行高 28px 时的 5px）。
     * 斜线只在这一层里画，纵向是百分比、拿不到 px，所以止点用这个估算值；
     * 行更高时斜线止点会离圆点稍远一点（宁可有 1–2px 空隙，也不要戳进圆环内部）。
     */
    const NODE_EDGE_PCT = 18

    /** 右键菜单的估算宽度（px）：用于把菜单与子菜单夹在面板内（S.menu 的 maxWidth 是 280，这里取常用值）。 */
    const MENU_WIDTH = 200

    /**
     * 提交树调色板：ring = 同色系深色（圆环 / 标签描边与文字），fill = 同色系淡底（标签），
     * line = 同色系浅色**不透明**（连线）。连线必须不透明：半透明色在相邻行的 1px 重叠处会叠出更深的色带。
     * 按分支名排序取模分配，保证跨渲染稳定。
     */
    const GRAPH_COLORS = [
      { ring: '#2563eb', line: '#9dbdf7', fill: 'rgba(37,99,235,0.14)' },
      { ring: '#16a34a', line: '#93d8b0', fill: 'rgba(22,163,74,0.14)' },
      { ring: '#7c3aed', line: '#c4b0f7', fill: 'rgba(124,58,237,0.14)' },
      { ring: '#ea580c', line: '#f7b78f', fill: 'rgba(234,88,12,0.14)' },
      { ring: '#db2777', line: '#f4a3c6', fill: 'rgba(219,39,119,0.14)' },
      { ring: '#0d9488', line: '#8ad3cd', fill: 'rgba(13,148,136,0.14)' },
      { ring: '#ca8a04', line: '#eed08a', fill: 'rgba(202,138,4,0.14)' },
      { ring: '#4f46e5', line: '#a9a5f2', fill: 'rgba(79,70,229,0.14)' },
    ]

    const STATE_COLORS = {
      M: '#3b82f6', A: '#22c55e', D: '#9ca3af', R: '#3b82f6', C: '#3b82f6',
      T: '#9ca3af', U: '#ef4444', '?': '#22c55e', '!': '#9ca3af',
    }

    /** 合并按钮样式：kind = undefined | 'primary' | 'danger'。 */
    function btnStyle(kind, disabled) {
      const style = { ...S.button }
      if (kind === 'primary') Object.assign(style, S.buttonPrimary)
      if (kind === 'danger') Object.assign(style, S.buttonDanger)
      if (disabled === true) Object.assign(style, S.buttonOff)
      return style
    }

    function Btn(props) {
      const base = btnStyle(props.kind, props.disabled)
      return h('button', {
        style: props.style === undefined ? base : { ...base, ...props.style },
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.onClick,
      }, props.children)
    }

    /**
     * 加载中图标：SVG 圆弧 + requestAnimationFrame 驱动的旋转。
     *
     * 为什么不用 CSS 动画：静态半区不能注入样式表（约定不写 document.head），也不想依赖 SMIL
     * 在浏览器/React 里的支持；rAF 只更新这一个小图标的 `rotate`，代价可忽略（每帧仅重渲染它自己）。
     */
    function Spinner(props) {
      const size = typeof props.size === 'number' ? props.size : 14
      const color = typeof props.color === 'string' ? props.color : '#3b82f6'
      const [angle, setAngle] = useState(0)
      useEffect(() => {
        let live = true
        let frame = null
        const startedAt = Date.now()
        function tick() {
          if (!live) return
          setAngle(((Date.now() - startedAt) / 900 * 360) % 360)
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        return () => {
          live = false
          if (frame !== null) cancelAnimationFrame(frame)
        }
      }, [])
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, h('g', { transform: `rotate(${Math.round(angle)} 12 12)` },
        h('circle', {
          cx: 12,
          cy: 12,
          r: 9,
          fill: 'none',
          stroke: color,
          strokeWidth: 3,
          strokeLinecap: 'round',
          // 只画约 3/4 圈，转起来才看得出在动
          strokeDasharray: '42 57',
        }),
      ))
    }

    /** 等待提示：转圈图标 + 文案。 */
    function Busy(props) {
      return h('span', { style: S.hline }, h(Spinner, { size: 13 }), h('span', null, props.text))
    }

    /**
     * 文本输入框：统一外观 + 自己的焦点高亮。
     * 零构建下写不了 `:focus`，所以用组件内部状态模拟（只重渲染这个输入框本身）。
     * 需要拿到 DOM 时传 `inputRef`（React 的 `ref` 不随 props 透传）。
     */
    function TextInput(props) {
      const [focused, setFocused] = useState(false)
      // inputRef / style / onFocus / onBlur 单独取出来，别混进 rest 透传到 DOM（React 会警告未知属性）。
      const { inputRef, style, onFocus, onBlur, ...rest } = props
      return h('input', {
        ...rest,
        ref: inputRef,
        style: {
          ...S.input,
          ...(style === undefined ? null : style),
          ...(focused === true ? S.inputFocus : null),
        },
        onFocus: (event) => {
          setFocused(true)
          if (typeof onFocus === 'function') onFocus(event)
        },
        onBlur: (event) => {
          setFocused(false)
          if (typeof onBlur === 'function') onBlur(event)
        },
      })
    }

    /** 多行输入框：同上，焦点态共用一套配色。 */
    function TextArea(props) {
      const [focused, setFocused] = useState(false)
      const { style, onFocus, onBlur, ...rest } = props
      return h('textarea', {
        ...rest,
        style: {
          ...S.area,
          ...(style === undefined ? null : style),
          ...(focused === true ? S.inputFocus : null),
        },
        onFocus: (event) => {
          setFocused(true)
          if (typeof onFocus === 'function') onFocus(event)
        },
        onBlur: (event) => {
          setFocused(false)
          if (typeof onBlur === 'function') onBlur(event)
        },
      })
    }

    /* ------------------------------------------------------------------ 图标 */

    /** 引导页胶囊、tab chip 与工具栏的图形（分支图形，无外部依赖）。 */
    function GitGlyph(props) {
      const s = typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', className: props.className, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('circle', { cx: 4.3, cy: 3.3, r: 1.6 }),
        h('circle', { cx: 4.3, cy: 12.7, r: 1.6 }),
        h('circle', { cx: 11.7, cy: 6.5, r: 1.6 }),
        h('path', { d: 'M4.3 4.9v6.2' }),
        h('path', { d: 'M5.9 3.3h2.4a3.4 3.4 0 0 1 3.4 3.2' }),
      )
    }

    /* ------------------------------------------------------------- 小工具函数 */

    /** RPC 失败对象（{code,message,details}）→ 可读文本。 */
    function errorText(error) {
      if (error === null || error === undefined) return ''
      const code = typeof error.code === 'string' ? error.code : 'git-vcs/error'
      const message = typeof error.message === 'string' ? error.message : String(error)
      let extra = ''
      const details = error.details
      if (typeof details === 'string') extra = details
      else if (details !== null && typeof details === 'object') {
        if (Array.isArray(details.argv)) extra = details.argv.join(' ')
        else if (typeof details.exitCode === 'number') extra = `exit ${details.exitCode}`
      }
      return `${code}: ${message}${extra === '' ? '' : `\n${extra}`}`
    }

    function shortDate(value) {
      return typeof value === 'string' ? value.slice(0, 19).replace('T', ' ') : ''
    }

    function splitPath(path) {
      const at = path.lastIndexOf('/')
      if (at < 0) return { dir: '', name: path }
      return { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
    }

    /** 字符宽度估算（10px 字号）：CJK / 全角按 10.5px，其余按 6.1px。用于提交树列的自适应宽度。 */
    function glyphWidth(text) {
      let width = 0
      for (const ch of text) width += ch.codePointAt(0) > 0x2e7f ? 10.5 : 6.1
      return width
    }

    /** 状态字母：冲突=U、未跟踪=?、忽略=!，否则取暂存 / 工作区字母（都变时按工作区）。 */
    function statusLetter(entry) {
      if (entry.conflicted) return { text: 'U', color: STATE_COLORS.U }
      if (entry.untracked) return { text: '?', color: STATE_COLORS['?'] }
      if (entry.ignored) return { text: '!', color: STATE_COLORS['!'] }
      const index = entry.index
      const worktree = entry.worktree
      if (index !== '.' && worktree !== '.') return { text: worktree, color: STATE_COLORS[worktree] || STATE_COLORS.M }
      if (index !== '.') return { text: index, color: STATE_COLORS[index] || STATE_COLORS.M }
      return { text: worktree, color: STATE_COLORS[worktree] || STATE_COLORS.M }
    }

    /** 解析 `@@ -a,b +c,d @@`：拿到两边的起始行号（缺省 count 视为 1；新文件是 -0,0）。 */
    function parseHunkHeader(line) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (match === null) return null
      return { oldStart: Number(match[1]), newStart: Number(match[2]) }
    }

    /**
     * 统一 diff 文本 → 左侧行号 + 着色代码行（长行默认换行，不产生横向滚动）。
     *
     * 行号取"当前文件"那一侧：上下文与新增行用新文件行号，删除行用它在新文件里原本的行号（旧侧）。
     * 可选 `focusRange` = { start, end }（整个改动块高亮）与 `lineRefs`（把每行 DOM 收进 `lineRefs.current[行号]`，
     * 供 ↑/↓ 按 offsetTop 跳转）。
     */
    function DiffView(props) {
      if (props.loading === true) return h('div', { style: S.placeholder }, Busy({ text: '读取差异…' }))
      const text = props.text
      if (text === null || text === undefined || text === '') return h('div', { style: S.placeholder }, '无差异内容')
      const refs = props.lineRefs
      const focus = props.focusRange === undefined ? null : props.focusRange
      let oldLine = 0
      let newLine = 0
      return h('div', null, text.split('\n').map((line, index) => {
        let style = S.lineRow
        let number = ''
        if (line.startsWith('@@')) {
          const hunk = parseHunkHeader(line)
          if (hunk !== null) {
            oldLine = hunk.oldStart
            newLine = hunk.newStart
          }
          style = { ...style, ...S.lineHunk }
        } else if (line.startsWith('+++') || line.startsWith('---')) {
          // 文件头（+++ / ---），不参与行号计数
        } else if (line.startsWith('+')) {
          number = String(newLine)
          newLine += 1
          style = { ...style, ...S.lineAdd }
        } else if (line.startsWith('-')) {
          number = String(oldLine)
          oldLine += 1
          style = { ...style, ...S.lineDel }
        } else if (line === '' || line.startsWith(' ')) {
          number = String(newLine)
          oldLine += 1
          newLine += 1
        }
        // 其余（diff --git / index / new file mode / \ No newline…）只占位，不给行号。
        const focused = focus !== null && index >= focus.start && index <= focus.end
        const gutterStyle = focused === true ? { ...S.gutter, ...S.gutterFocus } : S.gutter
        const nodeProps = refs === undefined ? {} : { ref: (node) => { refs.current[index] = node } }
        return h('div', { key: index, style, ...nodeProps },
          h('span', { style: gutterStyle }, number),
          h('span', { style: S.lineText }, line === '' ? ' ' : line),
        )
      }))
    }

    /**
     * Log 的提交树列：**多泳道**图，画法对齐 IDEA 与 `git log --graph`。
     *
     * 几何全部由 `logLaneLayout` 算好（本行有哪些泳道、圆点在第几条、哪些是直行段、哪些是分叉/汇合斜线），
     * 这里只负责画：
     *   · 竖直段用 div：能用 `calc(50% ± 半径)` 精确止于圆环外沿，圆点内部不画线；
     *     上下各向相邻行越界 1px 重叠（不透明色重叠不会变深，但能消除行高含小数时的接缝）。
     *   · 斜线用一张铺满泳道区的 SVG（纵向 0–100 的百分比坐标），跨泳道的分叉/汇合才画得出来。
     *   · 圆点：SVG 真圆（外径 10px、圆环 2px），HEAD 提交**实心**、其余空心。
     *   · 分支标签排在泳道区右侧**统一对齐**（跟着泳道左右跳会很难读）。
     * 列宽由 GitBody 依泳道数与标签内容算好传进来（自适应，且不提供拖动手柄）。
     */
    function GraphCell(props) {
      const labels = Array.isArray(props.labels) ? props.labels : []
      const row = props.row === undefined || props.row === null ? null : props.row
      const area = typeof props.area === 'number' ? props.area : LANE_GAP
      const lane = row === null ? 0 : row.lane
      const colorIndex = row === null ? 0 : row.color
      const ring = GRAPH_COLORS[colorIndex % GRAPH_COLORS.length].ring
      const lineOf = (index) => GRAPH_COLORS[index % GRAPH_COLORS.length].line
      /** 第 index 条泳道的中心 x（px）。 */
      const center = (index) => index * LANE_GAP + LANE_GAP / 2
      const verticals = row === null ? [] : row.verticals
      const diagonals = row === null ? [] : row.diagonals
      const verticalStyle = (segment) => {
        const base = {
          ...S.graphLine,
          // 线宽 2px，往左挪 1px 才是「中心落在泳道中心线上」（圆点的圆心也在这里）。
          left: `${center(segment.lane) - 1}px`,
          background: lineOf(segment.color),
        }
        if (segment.kind === 'through') return { ...base, top: '-1px', bottom: '-1px' }
        if (segment.kind === 'up') return { ...base, top: '-1px', height: `calc(50% - ${NODE_RADIUS - 1}px)` }
        return { ...base, top: `calc(50% + ${NODE_RADIUS}px)`, bottom: '-1px' }
      }
      const box = { ...S.tdGraph, flex: `0 0 ${props.width}px`, width: `${props.width}px` }
      return h('div', {
        style: box,
        title: labels.length === 0
          ? undefined
          : labels.map((label) => `${label.kind === 'local' ? '本地分支' : '远程分支'} ${label.name}`).join('\n'),
      },
        h('div', { style: { ...S.laneBox, width: `${area}px` } },
          verticals.map((segment, index) => h('div', { key: `v${index}`, style: verticalStyle(segment) })),
          h('svg', {
            style: S.laneLines,
            viewBox: `0 0 ${Math.max(1, area)} 100`,
            preserveAspectRatio: 'none',
            'aria-hidden': 'true',
          }, diagonals.map((segment, index) => h('line', {
            key: `d${index}`,
            x1: center(segment.from),
            y1: segment.dir === 'in' ? 0 : 50 + NODE_EDGE_PCT,
            x2: center(segment.to),
            y2: segment.dir === 'in' ? 50 - NODE_EDGE_PCT : 100,
            stroke: lineOf(segment.color),
            strokeWidth: 2,
            vectorEffect: 'non-scaling-stroke',
          }))),
          h('svg', {
            style: { ...S.node, left: `${center(lane) - 6}px` },
            width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true',
          }, h('circle', {
            cx: 6,
            cy: 6,
            r: NODE_R,
            fill: props.filled === true ? ring : 'none',
            stroke: ring,
            strokeWidth: 2,
          })),
        ),
        h('div', { style: S.chips }, labels.map((label) => h('span', {
          key: `${label.kind}:${label.name}`,
          style: {
            ...S.chipBranch,
            ...(label.head === true ? S.chipHead : null),
            color: label.ring,
            background: label.fill,
            borderStyle: label.kind === 'remote' ? 'dashed' : 'solid',
          },
          title: `${label.kind === 'local' ? '本地分支' : '远程分支'}：${label.name}`,
        }, label.name))),
      )
    }

    /**
     * 列宽拖动手柄。用 pointer capture：指针拖出单元格之后 move 事件仍然送到这个手柄，
     * 所以不必给 window / document 挂监听；起始宽度直接量父单元格，不维护第二份宽度状态。
     */
    function ResizeHandle(props) {
      const [active, setActive] = useState(false)
      const drag = useRef(null)
      function start(event) {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const host = event.currentTarget.parentElement
        const width = host === null || host === undefined ? props.width : host.getBoundingClientRect().width
        drag.current = { x: event.clientX, width }
        setActive(true)
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }
      function move(event) {
        if (drag.current === null) return
        event.preventDefault()
        props.onResize(drag.current.width + (event.clientX - drag.current.x))
      }
      function stop(event) {
        if (drag.current === null) return
        drag.current = null
        setActive(false)
        if (typeof event.currentTarget.releasePointerCapture === 'function'
          && event.currentTarget.hasPointerCapture(event.pointerId) === true) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }
      return h('span', {
        style: active === true ? { ...S.resizer, ...S.resizerOn } : S.resizer,
        title: '拖动调整列宽',
        onPointerDown: start,
        onPointerMove: move,
        onPointerUp: stop,
        onPointerCancel: stop,
      }, h('span', { style: S.resizerBar }))
    }

    /**
     * 提交详情面板顶边的拖拽条：上下拖动改变面板高度（往上拖变高）。
     * 同样用 pointer capture，拖出面板后事件仍回这个元素，不挂 window 监听。
     */
    function RowSplitter(props) {
      const [active, setActive] = useState(false)
      const drag = useRef(null)
      function start(event) {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const host = event.currentTarget.parentElement
        const size = host === null || host === undefined ? props.height : host.getBoundingClientRect().height
        drag.current = { y: event.clientY, size }
        setActive(true)
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }
      function move(event) {
        if (drag.current === null) return
        event.preventDefault()
        props.onResize(drag.current.size - (event.clientY - drag.current.y))
      }
      function stop(event) {
        if (drag.current === null) return
        drag.current = null
        setActive(false)
        if (typeof event.currentTarget.releasePointerCapture === 'function'
          && event.currentTarget.hasPointerCapture(event.pointerId) === true) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }
      return h('div', {
        style: active === true ? { ...S.splitterY, ...S.splitterYOn } : S.splitterY,
        title: '拖动调整提交详情高度',
        onPointerDown: start,
        onPointerMove: move,
        onPointerUp: stop,
        onPointerCancel: stop,
      }, h('div', { style: S.splitterYBar }))
    }

    /* ------------------------------------------------------------------ 主体 */

    /**
     * 面板正文。
     * @param props - 注册项 inject 工厂注入的 { call }；call(endpoint, payload) 返回 RPC 信封。
     */
    function GitBody(props) {
      const rawCall = props.call
      // 会话工作目录：标准 prop useSessions 给出 current / byId，用来当默认仓库路径。
      const useSessions = props.useSessions
      const sessions = typeof useSessions === 'function' ? useSessions((state) => state) : undefined

      const [cwd, setCwd] = useState('')
      const [applied, setApplied] = useState('')
      const [tab, setTab] = useState('changes')
      const [repo, setRepo] = useState(null)
      const [config, setConfig] = useState(null)
      const [status, setStatus] = useState(null)
      const [commits, setCommits] = useState([])
      /** 提交树是否还有更早的提交可拉（首页拉满一页即为真；拉不满一页说明到底了）。 */
      const [logHasMore, setLogHasMore] = useState(false)
      const [branches, setBranches] = useState({ local: [], remote: [] })
      const [stashes, setStashes] = useState([])
      const [remotes, setRemotes] = useState(null)
      const [remoteLoading, setRemoteLoading] = useState(false)
      const [shown, setShown] = useState(null)
      const [showLoading, setShowLoading] = useState(false)
      const [selected, setSelected] = useState(null)
      const [patch, setPatch] = useState(null)
      const [patchLoading, setPatchLoading] = useState(false)
      const [commands, setCommands] = useState([])
      const [message, setMessage] = useState('')
      const [amend, setAmend] = useState(false)
      const [newBranch, setNewBranch] = useState('')
      const [commitBranch, setCommitBranch] = useState('')
      const [stashMessage, setStashMessage] = useState('')
      const [remoteName, setRemoteName] = useState('')
      const [remoteUrl, setRemoteUrl] = useState('')
      const [remotePush, setRemotePush] = useState('')
      const [confirm, setConfirm] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [busyLabel, setBusyLabel] = useState('')
      const [notice, setNotice] = useState(null)
      /**
       * cwd 不是 git 仓库：整个面板换成一块居中空态（只有一个「初始化仓库」按钮），
       * 页签 / 变更 / 提交 / 历史等一律不渲染 —— 那些内容在非仓库下全是空壳或报错。
       */
      const [noRepo, setNoRepo] = useState(false)
      const [initBusy, setInitBusy] = useState(false)
      /** 提交勾选：显式记录 path → bool；`selectNew` 决定刷新后新出现的改动默认是否勾上。 */
      const [checkedPaths, setCheckedPaths] = useState({})
      const [selectNew, setSelectNew] = useState(true)
      /** 推送认证：push 回 auth-required 时在这里开表单（IDEA 的"输账号密码/Token → 存进 git 凭据"）。 */
      const [authFor, setAuthFor] = useState(null)
      const [authUser, setAuthUser] = useState('')
      const [authSecret, setAuthSecret] = useState('')
      const [authSaving, setAuthSaving] = useState(false)
      const [remoteUser, setRemoteUser] = useState('')
      const [remoteSecret, setRemoteSecret] = useState('')
      const [tick, setTick] = useState(0)
      /** Log 列宽：date / message / author / commit 可拖；graph 由 logGraphWidth 依内容自适应。 */
      const [logWidths, setLogWidths] = useState({ date: 148, message: 320, author: 104, commit: 96 })
      /** message 列默认吃掉剩余宽度；被用户拖动过之后改成固定宽度（总宽超出即横向滚动）。 */
      const [msgAuto, setMsgAuto] = useState(true)
      /** Log 行的鼠标悬停高亮：零构建下没有 CSS :hover，用状态模拟（只在哈希变化时 set，避免无谓渲染）。 */
      const [hoverHash, setHoverHash] = useState(null)
      /** Branches 页的分支行悬停键（`本地:main` 这种），同样只为 hover 效果，行本身不是"选中"状态。 */
      const [hoverBranch, setHoverBranch] = useState(null)
      /** 提交详情面板：高度可拖、默认不展开任何文件的差异。 */
      const [detailHeight, setDetailHeight] = useState(300)
      const [detailFile, setDetailFile] = useState(null)
      const [detailHover, setDetailHover] = useState(null)
      const [filePatch, setFilePatch] = useState(null)
      const [fileLoading, setFileLoading] = useState(false)
      /** 提交行右键菜单：{ hash, x, y, bounds }；submenuStack 是逐级展开的子菜单（根相对坐标）。 */
      const [menu, setMenu] = useState(null)
      const [menuHover, setMenuHover] = useState(null)
      const [submenuStack, setSubmenuStack] = useState([])
      const [focusBranch, setFocusBranch] = useState(false)
      const rootRef = useRef(null)
      const menuRef = useRef(null)
      const branchRef = useRef(null)
      const noticeTimer = useRef(null)
      /** 差异导航（↑/↓ 跳到上一个/下一个 @@ 改动块）：两个差异面板各一套「聚焦行 + 容器 + 行节点表」。 */
      const [patchFocus, setPatchFocus] = useState(null)
      const patchBoxRef = useRef(null)
      const patchLineRefs = useRef([])
      const [detailFocus, setDetailFocus] = useState(null)
      const detailBoxRef = useRef(null)
      const detailLineRefs = useRef([])
      const alive = useRef(true)
      const appliedRef = useRef('')
      appliedRef.current = applied
      /** 提交树已加载条数 / 是否正在续拉：滚动事件不经过 state，用 ref 读最新值、并防重入。 */
      const logLoadedRef = useRef(0)
      const logLoadingRef = useRef(false)
      /** 提交树派生数据的缓存（见 logGraphData）。 */
      const logGraphRef = useRef(null)

      /** 统一调用：把 RPC 信封与异常都收敛成 { ok, value } / { ok:false, error }。 */
      async function rpc(endpoint, payload) {
        const body = { cwd: appliedRef.current, ...(payload === undefined ? {} : payload) }
        try {
          const result = await rawCall(endpoint, body)
          if (result === null || typeof result !== 'object') {
            return { ok: false, error: { code: 'git-vcs/empty', message: '宿主返回了空响应', details: {} } }
          }
          return result
        } catch (cause) {
          return {
            ok: false,
            error: { code: 'git-vcs/transport', message: cause instanceof Error ? cause.message : String(cause), details: {} },
          }
        }
      }

      /**
       * 拉一次全量快照（一次 RPC，host 侧并发探测）。
       * 提交树按「已加载条数」一次拉回（上限 LOG_MAX_ROWS），这样刷新/自动刷新不会把滚到深处的
       * 提交树缩回一页；`all: true` 让树里出现**所有分支**的节点，而不只是当前分支。
       */
      async function refresh(label) {
        setBusy(true)
        setBusyLabel(label)
        const want = Math.min(Math.max(logLoadedRef.current, LOG_PAGE), LOG_MAX_ROWS)
        const result = await rpc('repo/snapshot', { limit: want, all: true, consoleLimit: 60 })
        if (!alive.current) return
        setBusy(false)
        setBusyLabel('')
        setLoading(false)
        if (!result.ok) {
          // 不是仓库 → 走空态（含"初始化仓库"按钮），不再弹 toast：整页已经把原因说清楚了。
          if (result.error.code === 'git-vcs/not-a-repo') {
            setNoRepo(true)
            setRepo(null)
            return
          }
          reportError(result.error)
          return
        }
        setNoRepo(false)
        const value = result.value
        const rows = Array.isArray(value.commits) ? value.commits : []
        setRepo(value.repo)
        setConfig(value.config)
        setStatus(value.status)
        setCommits(rows)
        logLoadedRef.current = rows.length
        // 只拉回一页就说明后面还有；已到渲染上限则不再续拉。
        setLogHasMore(rows.length >= want && rows.length < LOG_MAX_ROWS)
        setBranches(value.branches === undefined ? { local: [], remote: [] } : value.branches)
        setStashes(Array.isArray(value.stashes) ? value.stashes : [])
        setCommands(Array.isArray(value.console) ? value.console : [])
      }

      /**
       * 空态里的「初始化仓库」：`git init` 之后立刻按正常流程拉一次快照 —— 成功即 setNoRepo(false)，
       * 面板自己从空态长回完整功能（不需要用户再点一次 Refresh）。
       */
      async function initRepo() {
        if (initBusy === true) return
        setInitBusy(true)
        const result = await rpc('repo/init', {})
        if (!alive.current) return
        setInitBusy(false)
        if (!result.ok) {
          reportError(result.error)
          return
        }
        const value = result.value
        logLoadedRef.current = 0
        setNoRepo(false)
        await refresh('读取仓库…')
        if (!alive.current) return
        flash(
          value !== null && value !== undefined && value.already === true
            ? '这里已经是 git 仓库了'
            : `已在分支 ${value?.branch ?? ''} 上初始化 git 仓库`,
          false,
          4000,
        )
      }

      /**
       * 提交树续拉下一页（滚到底触发；host 侧用 `--skip` 接着上次的窗口取）。
       *
       * 首屏与续拉在 host 里共用同一套参数，所以两次窗口是接着的；但两次调用之间可能落了新提交
       * （窗口整体后移一格），因此按 hash 去重后再追加，宁可少一行也不能出现重复行。
       */
      async function loadMoreLog() {
        if (logLoadingRef.current === true || logHasMore !== true) return
        if (logLoadedRef.current >= LOG_MAX_ROWS) {
          setLogHasMore(false)
          return
        }
        logLoadingRef.current = true
        const result = await rpc('log', { limit: LOG_PAGE, skip: logLoadedRef.current, all: true })
        logLoadingRef.current = false
        if (!alive.current) return
        if (!result.ok) {
          reportError(result.error)
          setLogHasMore(false)
          return
        }
        const rows = Array.isArray(result.value.commits) ? result.value.commits : []
        setCommits((prev) => {
          const known = new Set(prev.map((row) => row.hash))
          const fresh = rows.filter((row) => known.has(row.hash) === false)
          const next = fresh.length === 0 ? prev : [...prev, ...fresh]
          // 续拉是串行的（logLoadingRef 挡着），这里直接赋值即可。
          logLoadedRef.current = next.length
          return next
        })
        if (rows.length < LOG_PAGE) setLogHasMore(false)
      }

      /** 提交树滚动到接近底部就续拉：提前 160px 触发，滚动手感上不会"撞到底才转圈"。 */
      function onLogScroll(event) {
        const box = event.currentTarget
        if (box.scrollHeight - box.scrollTop - box.clientHeight > 160) return
        void loadMoreLog()
      }

      /**
       * 差异里的"改动块"：连续的 +/- 行算一块。
       * 同一 hunk 里被上下文行隔开的两处改动是**两块**（这是 ↑/↓ 的一站，不是 `@@` 头）。
       * 文件头 `---` / `+++` 不算改动行。
       */
      function diffBlocks(patchText) {
        const lines = typeof patchText === 'string' ? patchText.split('\n') : []
        const blocks = []
        let current = null
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]
          const changed = (line.startsWith('+') || line.startsWith('-'))
            && line.startsWith('+++') === false && line.startsWith('---') === false
          if (changed === false) {
            current = null
            continue
          }
          if (current === null) {
            current = { start: index, end: index }
            blocks.push(current)
          } else {
            current.end = index
          }
        }
        return blocks
      }

      /**
       * 光标（当前停在第几个改动块）：**完全以滚动位置为准**，不记"上次点过哪一行"。
       *   · 顶端已经滚到视口顶（2px 容差）的最后一块 = 当前块；
       *   · 已经贴到底部时，视口内可见的最后一块也算当前块 —— 否则最后一块顶不到顶，↑ 会把它跳过。
       * cursor = -1 表示还停在所有改动块之上（页首）。
       */
      function diffCursor(patchText, boxRef, lineRefs) {
        const blocks = diffBlocks(patchText)
        const box = boxRef.current
        if (box === null || box === undefined || blocks.length === 0) return { blocks, cursor: -1 }
        const top = box.scrollTop
        const maxTop = Math.max(0, box.scrollHeight - box.clientHeight)
        const atBottom = top >= maxTop - 2
        let cursor = -1
        for (let index = 0; index < blocks.length; index++) {
          const node = lineRefs.current[blocks[index].start]
          if (node === null || node === undefined) continue
          const offset = node.offsetTop
          if (offset <= top + 2) cursor = index
          else if (atBottom === true && offset <= top + box.clientHeight) cursor = index
        }
        return { blocks, cursor }
      }

      /**
       * ↑ / ↓ 导航：每次点击都用**当前滚动位置**重算光标，再走一块。
       * 于是页首时 ↑ 不可用（上面确实没有改动）、手动滚动之后点也不会跳回旧位置。
       */
      function diffNav(patchText, boxRef, lineRefs, setFocus) {
        const { blocks, cursor } = diffCursor(patchText, boxRef, lineRefs)
        const go = (target) => {
          if (target < 0 || target >= blocks.length) return
          const line = blocks[target].start
          setFocus(line)
          const box = boxRef.current
          const node = lineRefs.current[line]
          if (box !== null && box !== undefined && node !== null && node !== undefined) {
            // 滚到该块首行本身：光标是按滚动位置反推的，对齐到顶才不会来回打架。
            box.scrollTop = Math.max(0, node.offsetTop)
          }
        }
        return {
          total: blocks.length,
          cursor,
          canPrev: cursor > 0,
          canNext: cursor < blocks.length - 1,
          prev: () => go(cursor - 1),
          next: () => go(cursor < 0 ? 0 : cursor + 1),
        }
      }

      /** 差异面板工具条上的改动统计：有光标时显示"第 n/总 处"，否则只报总数。 */
      function diffCountLabel(nav) {
        if (nav.total === 0) return null
        return nav.cursor >= 0 ? `第 ${nav.cursor + 1}/${nav.total} 处改动` : `${nav.total} 处改动`
      }

      /** 差异区滚动时同步光标（只有变化时才 set，避免滚动时狂渲染）。 */
      function syncDiffFocus(patchText, boxRef, lineRefs, focus, setFocus) {
        const { blocks, cursor } = diffCursor(patchText, boxRef, lineRefs)
        const line = cursor < 0 ? null : blocks[cursor].start
        if (line !== focus) setFocus(line)
      }

      /** 未显式输入仓库路径时，用会话工作目录（首次拿到就自动打开）。 */
      useEffect(() => {
        if (applied !== '' || cwd !== '') return
        const summary = sessions === undefined || sessions === null || sessions.byId === undefined
          ? undefined
          : sessions.byId[sessions.current]
        const candidate = summary === undefined || summary === null ? '' : summary.cwd
        if (typeof candidate === 'string' && candidate !== '') {
          setCwd(candidate)
          setApplied(candidate)
        }
      }, [sessions, applied, cwd])

      /** 首次进入 / 用户点「打开仓库」/ 点 Refresh：拉一次快照。 */
      useEffect(() => {
        alive.current = true
        if (applied === '') return undefined
        refresh('读取仓库…')
        return () => { alive.current = false }
      }, [applied, tick])

      /** 自动刷新（config.autoRefreshSeconds > 0 时生效）。 */
      const autoRefreshSeconds = config === null ? 0 : config.autoRefreshSeconds
      useEffect(() => {
        if (autoRefreshSeconds <= 0) return undefined
        const timer = setInterval(() => { setTick((n) => n + 1) }, autoRefreshSeconds * 1000)
        return () => clearInterval(timer)
      }, [autoRefreshSeconds])

      /**
       * 选中文件 → 拉该文件的 diff（只读，可关闭）。
       *
       * 必须把 `untracked` 一起转发：未跟踪文件不在 index 里，`git diff -- <path>` 恒为空，
       * 只有 host 的 `--no-index`（untracked=true）分支才拿得到"新文件"的整段差异。
       * 忽略文件（.gitignore 命中）没有可看的差异，直接不发请求。
       */
      useEffect(() => {
        if (selected === null) {
          setPatch(null)
          setPatchLoading(false)
          return undefined
        }
        if (selected.ignored === true) {
          setPatch('')
          setPatchLoading(false)
          return undefined
        }
        let live = true
        setPatch(null)
        setPatchLoading(true)
        setPatchFocus(null)
        rpc('diff', {
          path: selected.path,
          staged: selected.staged === true,
          untracked: selected.untracked === true,
        }).then((result) => {
          if (!live) return
          setPatchLoading(false)
          if (result.ok) setPatch(result.value.patch)
          else reportError(result.error)
        })
        return () => { live = false }
      }, [selected, applied])

      /**
       * 刷新 / 写操作后条目会变：选中项的处理。
       *
       *   · 已不在列表里（文件被别处提交、或已回滚）→ 收起差异面板与底部暂存/回滚操作条；
       *   · 还在但换了分组（刚点了「暂存」）→ 跟随到新的分组，避免右侧继续显示已经不存在的那种差异。
       *
       * 依赖只挂 status/applied：只在快照更新时校验，点击选中本身不需要重跑。
       */
      useEffect(() => {
        if (selected === null) return
        const entry = entries().find((row) => row.path === selected.path)
        if (entry === undefined) {
          setSelected(null)
          setPatch(null)
          setPatchLoading(false)
          return
        }
        if (selected.ignored === true) return
        const stagedNow = entry.staged === true
        const worktreeNow = entry.unstaged === true || entry.untracked === true
        if (selected.staged === true ? stagedNow === true : worktreeNow === true) return
        if (stagedNow === true || worktreeNow === true) {
          setSelected({ path: entry.path, staged: stagedNow, untracked: entry.untracked === true, ignored: false })
          return
        }
        setSelected(null)
        setPatch(null)
        setPatchLoading(false)
      }, [status, applied])

      /** 切到 Remotes 页才拉远程列表（懒加载，不占刷新的进程预算）。 */
      useEffect(() => {
        if (tab !== 'remotes' || applied === '') return undefined
        let live = true
        setRemoteLoading(true)
        setRemotes(null)
        rpc('remote/list', {}).then((result) => {
          if (!live) return
          setRemoteLoading(false)
          if (result.ok) setRemotes(result.value.remotes)
          else reportError(result.error)
        })
        return () => { live = false }
      }, [tab, applied, tick])

      /**
       * 写操作：调用端点 → 显示耗时 → 刷新快照。
       * `options.auth` 给出这次操作的认证上下文：若失败原因是缺认证（`git-vcs/auth-required`），
       * 就打开认证表单（而不是只弹一个错误），填完自动重试这次操作。
       */
      async function run(endpoint, payload, label, options) {
        setBusy(true)
        setBusyLabel(label)
        setNotice(null)
        const startedAt = Date.now()
        const result = await rpc(endpoint, payload)
        if (!alive.current) return null
        if (!result.ok) {
          const auth = options === undefined ? undefined : options.auth
          if (result.error.code === 'git-vcs/auth-required' && auth !== undefined) {
            setAuthFor(auth)
            setAuthSecret('')
            flash('推送需要认证：请填用户名与密码/Token（会存进 git 凭据，之后不用再填）', true, 6000)
          } else {
            reportError(result.error)
          }
          setBusy(false)
          setBusyLabel('')
          return null
        }
        const elapsed = Date.now() - startedAt
        // 必须走 flash：直接 setNotice 不会排自动消失的定时器 → toast 会一直挂在右下角。
        flash(`${label}完成 · ${elapsed} ms`, false, 3000)
        await refresh('刷新列表…')
        return result.value
      }

      /** 发起推送：把认证上下文一起带给 run，失败时好开认证表单。 */
      function pushWithAuth(payload, label, remoteName) {
        return run('push', payload, label, {
          auth: {
            remoteName: typeof remoteName === 'string' && remoteName !== '' ? remoteName : 'origin',
            payload,
            label,
            url: '',
          },
        })
      }

      /**
       * 认证表单需要"凭据存到哪个远程地址"：优先已加载的 remote 列表，其次 repo.remoteUrl（origin），
       * 都没有就拉一次 remote/list 再补上。地址只用于 `git credential approve` 的 host 匹配。
       */
      useEffect(() => {
        if (authFor === null || authFor.url !== '') return undefined
        const name = authFor.remoteName === '' ? 'origin' : authFor.remoteName
        const patch = (url) => setAuthFor((current) => (current === null || current.url !== '' ? current : { ...current, url }))
        const known = Array.isArray(remotes) ? remotes.find((item) => item.name === name) : undefined
        if (known !== undefined && known.fetch !== '') {
          patch(known.fetch)
          return undefined
        }
        if (remotes !== null) {
          patch(repo !== null && repo.remoteUrl !== '' ? repo.remoteUrl : '')
          return undefined
        }
        let live = true
        rpc('remote/list', {}).then((result) => {
          if (!live || !result.ok) return
          const hit = result.value.remotes.find((item) => item.name === name)
          patch(hit === undefined ? (repo !== null ? repo.remoteUrl : '') : hit.fetch)
        })
        return () => { live = false }
      }, [authFor, remotes, repo])

      /** 保存认证信息并（如果这次是被推送触发的）自动重推。 */
      async function saveCredential() {
        if (authFor === null) return
        const url = authFor.url !== '' ? authFor.url : (repo === null ? '' : repo.remoteUrl)
        if (url === '') {
          flash('还没有可用的远程地址：先在 Remotes 页添加远程', true, 5000)
          return
        }
        setAuthSaving(true)
        const result = await rpc('credential/approve', { url, username: authUser.trim(), secret: authSecret })
        setAuthSaving(false)
        if (!alive.current) return
        if (!result.ok) {
          reportError(result.error)
          return
        }
        const stored = result.value.stored === true
        flash(
          stored
            ? `凭据已保存到 git（${result.value.host}），下次推送不用再填`
            : '凭据助手没能保存（未配置 credential.helper），已记在本次会话：推送时会内嵌凭据',
          stored !== true,
          6000,
        )
        setAuthUser('')
        setAuthSecret('')
        const pending = authFor
        setAuthFor(null)
        if (pending.payload !== undefined) await run('push', pending.payload, pending.label, { auth: pending })
      }

      /** 顶部提示条：默认 2 秒后自动消失；错误类提示用更长的停留（6 秒）。 */
      function flash(text, bad, ms) {
        setNotice({ text, bad: bad === true })
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => { if (alive.current) setNotice(null) }, typeof ms === 'number' ? ms : 2000)
      }

      /**
       * 失败提示统一走右下角 toast（不再用顶部横幅：横幅是流内元素，出现/消失会顶动布局，
       * 而且失败信息长期挂在那里也不好看）。命令原文与 stderr 仍可在 Console 页回看。
       */
      function reportError(error) {
        if (error === null || error === undefined) return
        flash(errorText(error), true, 6000)
      }

      /** 兜底复制：老浏览器 / 无剪贴板权限时用临时 textarea + execCommand。 */
      function fallbackCopy(text) {
        try {
          if (typeof document === 'undefined' || document.body === null) return false
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          return ok === true
        } catch (cause) {
          return false
        }
      }

      /** 复制纯文本（提交 ID 等）：优先 navigator.clipboard，失败退化到 fallbackCopy。 */
      function copyText(text, label) {
        function done(ok) {
          if (!alive.current) return
          if (ok === true) flash(`已复制${label}：${text}`, false)
          else flash(`复制失败，请手动选择复制${label}：${text}`, true)
        }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined
            && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)))
            return
          }
        } catch (cause) {
          // 剪贴板被策略挡住：走下面的兜底
        }
        done(fallbackCopy(text))
      }

      /** 拖动列宽：graph 列不在此列（自适应且不可拖）；message 一旦拖动即改为固定宽度。 */
      function resizeColumn(id, next) {
        const limit = LOG_LIMITS[id]
        if (limit === undefined) return
        const width = Math.max(limit[0], Math.min(limit[1], Math.round(next)))
        setLogWidths((prev) => (prev[id] === width ? prev : { ...prev, [id]: width }))
        if (id === 'message') setMsgAuto(false)
      }

      function ask(label, job) {
        setConfirm({ label, run: job })
      }

      function closeDetail() {
        setSelected(null)
        setShown(null)
        setShowLoading(false)
        setDetailFile(null)
        setDetailHover(null)
        setFilePatch(null)
        setFileLoading(false)
      }

      function entries() {
        if (status === null || !Array.isArray(status.entries)) return []
        return status.entries
      }

      function stagedPaths() {
        return entries().filter((entry) => entry.staged).map((entry) => entry.path)
      }

      function changesOf(group) {
        return entries().filter((entry) => {
          if (group === 'conflicted') return entry.conflicted
          if (group === 'staged') return entry.staged && !entry.conflicted
          if (group === 'unstaged') return entry.unstaged && !entry.conflicted
          if (group === 'ignored') return entry.ignored === true
          return entry.untracked
        })
      }

      /* ---------------------------------------------------- 提交勾选（选哪些文件） */

      /** 可提交的改动：冲突文件要先把冲突解决掉，不参与勾选。 */
      function committablePaths() {
        return entries().filter((entry) => entry.conflicted !== true).map((entry) => entry.path)
      }

      /** 某个路径是否勾选：未记录过时按 `selectNew`（新出现的改动默认勾上）。 */
      function isChecked(path) {
        const state = checkedPaths[path]
        return state === undefined ? selectNew === true : state === true
      }

      /** 当前勾选的文件路径（提交就按它走，未勾选的一律不提交）。 */
      function checkedPathsList() {
        return committablePaths().filter((path) => isChecked(path))
      }

      function toggleChecked(path) {
        setCheckedPaths((current) => ({ ...current, [path]: isChecked(path) !== true }))
      }

      function setAllChecked(next) {
        setSelectNew(next === true)
        const map = {}
        for (const path of committablePaths()) map[path] = next === true
        setCheckedPaths(map)
      }

      /**
       * 快照更新后同步勾选表：丢掉已消失（或被提交掉）的路径，新出现的路径按 `selectNew` 落一条显式记录。
       * 只在真有变化时 setState，避免刷新时多一轮渲染。
       */
      useEffect(() => {
        const paths = committablePaths()
        setCheckedPaths((current) => {
          let next = null
          for (const path of paths) {
            if (current[path] === undefined) {
              next = next ?? { ...current }
              next[path] = selectNew === true
            }
          }
          for (const path of Object.keys(current)) {
            if (paths.includes(path) === false) {
              next = next ?? { ...current }
              delete next[path]
            }
          }
          return next ?? current
        })
      }, [status, selectNew])

      /** 点提交：已展示则收起，否则拉详情（**不带整次提交的 patch**，只拿元数据与变更文件列表）。 */
      function openCommit(hash) {
        if (shown !== null && shown.commit !== null && shown.commit !== undefined && shown.commit.hash === hash) {
          setShown(null)
          setShowLoading(false)
          return
        }
        setShown(null)
        setShowLoading(true)
        setDetailFile(null)
        setFilePatch(null)
        rpc('show', { rev: hash, noPatch: true }).then((result) => {
          if (!alive.current) return
          setShowLoading(false)
          if (result.ok) setShown(result.value)
          else reportError(result.error)
        })
      }

      /** 详情面板里点开某个文件 → 只拉这个文件在该次提交里的差异（默认一个都不拉）。 */      useEffect(() => {
        const commit = shown === null || shown.commit === null || shown.commit === undefined ? null : shown.commit
        if (detailFile === null || commit === null) {
          setFilePatch(null)
          setFileLoading(false)
          return undefined
        }
        let live = true
        setFilePatch(null)
        setFileLoading(true)
        setDetailFocus(null)
        rpc('show/file', { rev: commit.hash, path: detailFile }).then((result) => {
          if (!live) return
          setFileLoading(false)
          if (result.ok) setFilePatch(result.value.patch)
          else reportError(result.error)
        })
        return () => { live = false }
      }, [detailFile, shown, applied])

      /* ------------------------------------------------------- 提交行右键菜单 */

      /** 菜单根相对定位用的面板尺寸；值取不到时按 0 处理（不夹取，摆到点击处）。 */
      function rootBox() {
        const node = rootRef.current
        if (node === null || node === undefined) return { width: 0, height: 0 }
        const box = node.getBoundingClientRect()
        return { width: box.width, height: box.height }
      }

      function openMenu(event, item) {
        event.preventDefault()
        event.stopPropagation()
        const node = rootRef.current
        const box = node === null || node === undefined ? null : node.getBoundingClientRect()
        const left = box === null ? 0 : box.left
        const top = box === null ? 0 : box.top
        const maxX = Math.max(2, (box === null ? 0 : box.width) - MENU_WIDTH - 2)
        setMenu({
          hash: item.hash,
          x: Math.max(2, Math.min(event.clientX - left, maxX)),
          y: Math.max(2, event.clientY - top),
        })
        setMenuHover(null)
        setSubmenuStack([])
      }

      function closeMenu() {
        setMenu(null)
        setMenuHover(null)
        setSubmenuStack([])
      }

      /** 点菜单之外 / Esc 关闭：菜单自身先 stopPropagation，所以不会误关。 */
      useEffect(() => {
        if (menu === null) return undefined
        function onDown() { setMenu(null); setMenuHover(null); setSubmenuStack([]) }
        function onKey(event) { if (event.key === 'Escape') onDown() }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [menu])

      /** 菜单渲染后量一次高度，太靠下就往上挪（只夹一次，避免抖动）。 */
      useEffect(() => {
        if (menu === null) return
        const node = menuRef.current
        if (node === null || node === undefined) return
        const box = rootBox()
        if (box.height === 0) return
        const maxY = Math.max(2, box.height - node.getBoundingClientRect().height - 4)
        if (menu.y > maxY) setMenu((current) => (current === null ? null : { ...current, y: maxY }))
      }, [menu, submenuStack])

      /** 右键点「基于此提交新建分支…」后把详情面板里的输入框聚焦（面板先展开再聚焦）。 */
      useEffect(() => {
        if (focusBranch !== true) return
        const node = branchRef.current
        if (node !== null && node !== undefined) node.focus()
        setFocusBranch(false)
      }, [focusBranch, shown])

      /**
       * 悬停菜单项：叶子只收起比它更深的层级（否则鼠标一进子菜单就被关掉），
       * 父项在 `level` 位置展开自己的子菜单（父项所在层 = 子菜单在栈里的下标）。
       */
      function openSubmenu(entry, key, level, event) {
        setMenuHover(key)
        if (entry.items === undefined) {
          setSubmenuStack((current) => (current.length <= level ? current : current.slice(0, level)))
          return
        }
        const node = event.currentTarget
        const box = rootBox()
        const rect = node.getBoundingClientRect()
        const root = rootRef.current
        const rootRect = root === null || root === undefined ? null : root.getBoundingClientRect()
        const left = rootRect === null ? 0 : rootRect.left
        const top = rootRect === null ? 0 : rootRect.top
        let x = rect.right - left + 2
        if (box.width !== 0 && x + MENU_WIDTH > box.width - 2) x = Math.max(2, rect.left - left - MENU_WIDTH - 2)
        const y = Math.max(2, rect.top - top)
        const level_ = { key, items: entry.items, x, y }
        setSubmenuStack((current) => {
          const kept = current.slice(0, level)
          const existing = current[level]
          if (existing !== undefined && existing.key === key && current.length === level + 1) return current
          return [...kept, level_]
        })
      }

      /** 某个提交的右键菜单项：按功能分组（查看 / 复制 / 分支 / 修改历史），子菜单递归渲染。 */
      function commitMenuItems(commit) {
        const allowWrite = config === null || config.allowWrite !== false
        const allowDangerous = config === null || config.allowDangerous !== false
        return [
          { kind: 'group', label: '查看' },
          {
            id: 'detail',
            label: '展开提交详情',
            hint: '左键单击',
            onPick: () => openCommit(commit.hash),
          },
          { kind: 'group', label: '复制' },
          { id: 'copy-hash', label: '复制提交 ID（完整）', onPick: () => copyText(commit.hash, '提交 ID') },
          { id: 'copy-short', label: '复制短 ID', onPick: () => copyText(commit.shortHash, '短 ID') },
          { id: 'copy-subject', label: '复制提交信息', onPick: () => copyText(commit.subject, '提交信息') },
          { id: 'copy-author', label: '复制作者与邮箱', onPick: () => copyText(`${commit.author} <${commit.email}>`, '作者') },
          { kind: 'group', label: '分支' },
          {
            id: 'branch',
            label: '分支操作',
            items: [
              {
                id: 'branch-create',
                label: '基于此提交新建分支…',
                disabled: !allowWrite,
                onPick: () => { openCommit(commit.hash); setFocusBranch(true) },
              },
              {
                id: 'checkout',
                label: '检出此提交（分离 HEAD）',
                disabled: !allowWrite,
                onPick: () => ask(`检出 ${commit.shortHash}？会切换工作区到该提交（分离 HEAD）。`, () => run('checkout', { ref: commit.hash }, '检出中…')),
              },
              {
                id: 'merge',
                label: '把此提交合并到当前分支',
                disabled: !allowWrite,
                onPick: () => ask(`把 ${commit.shortHash} 合并到当前分支？`, () => run('merge', { ref: commit.hash }, '合并中…')),
              },
            ],
          },
          { kind: 'group', label: '修改历史（危险）' },
          {
            id: 'history',
            label: '修改历史',
            items: [
              {
                id: 'cherry-pick',
                label: '拣选（Cherry-Pick）',
                danger: true,
                disabled: !allowDangerous,
                onPick: () => run('cherry-pick', { rev: commit.hash }, 'Cherry-Pick 中…'),
              },
              {
                id: 'revert',
                label: '回滚（Revert）',
                danger: true,
                disabled: !allowDangerous,
                onPick: () => run('revert', { rev: commit.hash }, 'Revert 中…'),
              },
              {
                id: 'reset',
                label: '重置到此提交',
                items: [
                  {
                    id: 'reset-soft',
                    label: 'Soft',
                    hint: '改动留在暂存区',
                    danger: true,
                    disabled: !allowDangerous,
                    onPick: () => run('reset', { rev: commit.hash, mode: 'soft' }, 'Reset 中…'),
                  },
                  {
                    id: 'reset-mixed',
                    label: 'Mixed',
                    hint: '改动留在工作区',
                    danger: true,
                    disabled: !allowDangerous,
                    onPick: () => run('reset', { rev: commit.hash, mode: 'mixed' }, 'Reset 中…'),
                  },
                  {
                    id: 'reset-hard',
                    label: 'Hard',
                    hint: '丢弃全部改动',
                    danger: true,
                    disabled: !allowDangerous,
                    onPick: () => ask(`硬重置到 ${commit.shortHash}？会丢弃工作区与暂存区的改动。`, () => run('reset', { rev: commit.hash, mode: 'hard' }, '硬重置中…')),
                  },
                ],
              },
            ],
          },
        ]
      }

      /** 递归渲染一层菜单项；分组标题自带分隔线，父项 hover 时在 level 位置展开下一级。 */
      function menuRows(items, path, level) {
        return items.map((entry, index) => {
          const key = `${path}/${index}`
          if (entry.kind === 'group') {
            return h('div', { key },
              path === '' && index === 0 ? null : h('div', { style: S.menuSep }),
              h('div', { style: S.menuGroup }, entry.label),
            )
          }
          const inStack = submenuStack.some((item) => item.key === key)
          const on = menuHover === key || inStack
          const style = { ...S.menuItem }
          if (on && entry.disabled !== true) Object.assign(style, S.menuItemOn)
          if (entry.disabled === true) Object.assign(style, S.menuItemOff)
          if (entry.danger === true) Object.assign(style, S.menuItemDanger)
          return h('div', {
            key,
            style,
            title: entry.title,
            onMouseEnter: (event) => openSubmenu(entry, key, level, event),
            onClick: (event) => {
              event.stopPropagation()
              if (entry.disabled === true) return
              if (typeof entry.onPick !== 'function') {
                // 只作为子菜单入口的项：点击等价于展开下一级。
                openSubmenu(entry, key, level, event)
                return
              }
              closeMenu()
              entry.onPick()
            },
          },
            h('span', null, entry.label),
            entry.items === undefined ? null : h('span', { style: S.menuArrow }, '▸'),
            entry.items === undefined && typeof entry.hint === 'string' ? h('span', { style: S.menuHint }, entry.hint) : null,
          )
        })
      }

      function renderMenu() {
        if (menu === null) return null
        const commit = commits.find((row) => row.hash === menu.hash)
        if (commit === undefined) return null
        return h('div', null,
          h('div', {
            ref: menuRef,
            style: { ...S.menu, left: `${menu.x}px`, top: `${menu.y}px` },
            onMouseDown: (event) => event.stopPropagation(),
            onContextMenu: (event) => { event.preventDefault(); event.stopPropagation() },
          }, menuRows(commitMenuItems(commit), '', 0)),
          submenuStack.map((item, depth) => h('div', {
            key: item.key,
            style: { ...S.menu, left: `${item.x}px`, top: `${item.y}px` },
            onMouseDown: (event) => event.stopPropagation(),
            onContextMenu: (event) => { event.preventDefault(); event.stopPropagation() },
          }, menuRows(item.items, item.key, depth + 1))),
        )
      }

      async function commit() {
        // 只提交勾选的文件：host 会把勾选路径先 add 再按 pathspec 提交
        // （未跟踪文件不先 add 会让整单失败：pathspec did not match any file known to git）。
        // Amend 语义是"修补上一次提交"，忽略勾选（UI 里有说明）。
        const paths = amend === true ? [] : checkedPathsList()
        if (amend !== true && paths.length === 0) {
          flash('没有勾选任何文件，无法提交', true, 4000)
          return
        }
        const value = await run('commit', {
          message,
          amend,
          ...(paths.length === 0 ? {} : { paths }),
        }, '提交中…')
        if (value !== null) {
          setMessage('')
          setAmend(false)
          setSelected(null)
          // 提交后剩下的改动重新按默认勾选（全选）来。
          setSelectNew(true)
        }
      }

      /* ------------------------------------------------------------ 变更视图 */

      function renderChanges() {
        const groups = [
          { id: 'conflicted', label: '冲突' },
          { id: 'staged', label: '已暂存（Index）' },
          { id: 'unstaged', label: '已修改（Working Tree）' },
          { id: 'untracked', label: '未跟踪文件' },
        ]
        const patchNav = diffNav(patch, patchBoxRef, patchLineRefs, setPatchFocus)
        const patchBlocks = diffBlocks(patch)
        return h('div', { style: S.bodyStack },
          h('div', { style: S.col },
            groups.map((group) => {
              const list = changesOf(group.id)
              if (list.length === 0) return null
              return h('div', { key: group.id },
                h('div', { style: S.head }, `${group.label} · ${list.length}`),
                list.map((entry) => {
                  const mark = statusLetter(entry)
                  const parts = splitPath(entry.path)
                  const isOn = selected !== null && selected.path === entry.path && selected.staged === (group.id === 'staged')
                  const checked = isChecked(entry.path)
                  const locked = entry.conflicted === true
                  return h('div', {
                    key: `${group.id}:${entry.path}`,
                    style: isOn === true ? { ...S.row, ...S.rowOn } : S.row,
                    title: entry.path,
                    onClick: () => setSelected({
                      path: entry.path,
                      staged: group.id === 'staged',
                      untracked: entry.untracked === true,
                      ignored: entry.ignored === true,
                    }),
                  },
                    // 勾选框：点它只切换勾选，不打开右侧差异（stopPropagation）。
                    locked === true
                      ? h('span', { style: { ...S.check, ...S.checkDim }, title: '冲突文件需先解决冲突，不能提交' })
                      : h('span', {
                        style: checked === true ? { ...S.check, ...S.checkOn } : { ...S.check, ...S.checkOff },
                        title: checked === true ? '取消勾选（不提交此文件）' : '勾选（提交此文件）',
                        onClick: (event) => { event.stopPropagation(); toggleChecked(entry.path) },
                      }, '✓'),
                    h('span', { style: { ...S.letter, color: mark.color } }, mark.text),
                    parts.dir === '' ? null : h('span', { style: S.dir }, parts.dir),
                    h('span', { style: S.name }, parts.name),
                    entry.origPath === null || entry.origPath === undefined ? null : h('span', { style: S.dir }, ` ← ${entry.origPath}`),
                  )
                }),
              )
            }),
            entries().length === 0 ? h('div', { style: S.head }, '工作区干净，没有未提交的改动') : null,
            selected === null ? null : h('div', { style: S.bar },
              h('span', { style: S.dir }, selected.path),
              h('span', { style: S.spacer }),
              selected.staged === true
                ? Btn({
                  disabled: busy,
                  title: '取消暂存（git restore --staged）：把该文件移出索引',
                  onClick: () => run('unstage', { paths: [selected.path] }, '取消暂存中…'),
                  children: '取消暂存',
                })
                : Btn({
                  disabled: busy,
                  title: '暂存（git add）：把该文件当前内容放进索引',
                  onClick: () => run('stage', { paths: [selected.path] }, '暂存中…'),
                  children: '暂存',
                }),
              Btn({
                kind: 'danger',
                disabled: busy || selected.untracked === true,
                title: selected.untracked === true ? '未跟踪文件不走 restore（用回滚会走 clean 删除）' : '丢弃工作区改动',
                onClick: () => ask(`丢弃 ${selected.path} 的工作区改动？此操作不可撤销。`, () => run('discard', { paths: [selected.path] }, '回滚中…')),
                children: '回滚',
              }),
            ),
          ),
          selected === null ? null : h('div', { style: { ...S.detailBottom, height: `${detailHeight}px` } },
            h(RowSplitter, {
              height: detailHeight,
              onResize: (next) => setDetailHeight(Math.max(140, Math.min(720, Math.round(next)))),
            }),
            h('div', { style: S.bar },
              h('span', { style: S.name, title: selected.path }, `差异 · ${selected.path}${selected.staged === true ? '（已暂存）' : (selected.untracked === true ? '（未跟踪的新文件）' : (selected.ignored === true ? '（已忽略）' : '（工作区）'))}`),
              h('span', { style: S.spacer }),
              patchNav.total === 0 ? null : h('span', { style: { ...S.meta, flex: 'none' } }, diffCountLabel(patchNav)),
              Btn({ disabled: patchNav.canPrev !== true, title: '上一个改动', onClick: () => patchNav.prev(), children: '↑' }),
              Btn({ disabled: patchNav.canNext !== true, title: '下一个改动', onClick: () => patchNav.next(), children: '↓' }),
              Btn({ title: '关闭差异', onClick: () => setSelected(null), children: '×' }),
            ),
            h('div', {
              style: S.detailDiff,
              ref: patchBoxRef,
              onScroll: () => syncDiffFocus(patch, patchBoxRef, patchLineRefs, patchFocus, setPatchFocus),
            },
              selected.ignored === true
                ? h('div', { style: S.placeholder }, '命中 .gitignore 的文件没有可展示的差异')
                : (patchLoading === true || (patch !== null && patch !== '')
                  ? DiffView({
                    text: patch,
                    loading: patchLoading,
                    focusRange: patchBlocks.find((block) => block.start === patchFocus) ?? null,
                    lineRefs: patchLineRefs,
                  })
                  // 列表来自快照、差异是点击时实时拉的：两者不一致时给出明确解释（面板不监听文件系统）。
                  : h('div', { style: S.placeholder },
                    'Git 报告此文件当前没有差异 —— 上方列表可能已过期（面板不监听文件系统变更），点 Refresh 重新读取'))),
          ),
        )
      }

      function renderCommitBox() {
        const allowWrite = config === null || config.allowWrite !== false
        const total = committablePaths().length
        const picked = checkedPathsList().length
        const allPicked = total > 0 && picked === total
        // 没有任何改动时（或一个都没勾）不允许提交：以前点下去只会拿回一个 git 错误。
        const canCommit = busy !== true && allowWrite && message.trim() !== ''
          && (amend === true || picked > 0)
        const why = allowWrite !== true
          ? '写操作已被插件配置关闭（allowWrite=false）'
          : (message.trim() === ''
            ? '先填写提交信息'
            : (amend === true
              ? undefined
              : (total === 0 ? '工作区没有可提交的改动' : (picked === 0 ? '没有勾选任何文件' : undefined))))
        return h('div', { style: S.commit },
          h(TextArea, {
            style: S.area,
            placeholder: '提交信息（Commit Message）',
            value: message,
            onChange: (event) => setMessage(event.target.value),
          }),
          h('div', { style: S.hline },
            h('label', { style: S.meta },
              // 复选框不走 TextInput（那套是文本框外观）：用 accent-color 让它跟着主题变蓝，并去掉默认焦点圈。
              h('input', {
                type: 'checkbox',
                style: S.checkbox,
                checked: amend,
                disabled: config !== null && config.allowDangerous === false,
                onChange: (event) => setAmend(event.target.checked),
              }),
              ' Amend（修补上一次提交，忽略勾选）',
            ),
            h('span', { style: S.spacer }),
            Btn({
              disabled: busy || total === 0,
              title: allPicked ? '取消全选' : '全选',
              onClick: () => setAllChecked(allPicked !== true),
              children: allPicked ? '全不选' : '全选',
            }),
            Btn({
              disabled: busy || (message === '' && amend !== true),
              title: '清空提交信息与 Amend 勾选',
              onClick: () => { setMessage(''); setAmend(false) },
              children: '清空',
            }),
            h('span', { style: S.meta }, `已选 ${picked}/${total} 个文件 · ${stagedPaths().length} 个已暂存`),
            Btn({
              kind: 'primary',
              disabled: !canCommit,
              title: why,
              onClick: () => { void commit() },
              children: busy ? '执行中…' : (amend ? 'Amend' : 'Commit'),
            }),
          ),
        )
      }

      /* -------------------------------------------------------------- Log 视图 */

      function renderCommitBody(commit) {
        const files = shown === null || !Array.isArray(shown.files) ? [] : shown.files
        const allowDangerous = config === null || config.allowDangerous !== false
        const detailBlocks = diffBlocks(filePatch)
        return h('div', { style: S.detailBody },
          h('div', { style: S.detailSummary },
            h('div', { style: S.meta }, `${commit.author} · ${shortDate(commit.date)}`),
            h('div', { style: { ...S.name, whiteSpace: 'normal' }, title: commit.subject }, commit.subject),
            commit.body === '' || commit.body === undefined ? null : h('pre', { style: S.pre }, commit.body),
          ),
          h('div', { style: S.bar },
            Btn({ disabled: busy || !allowDangerous, onClick: () => run('revert', { rev: commit.hash }, 'Revert 中…'), children: 'Revert' }),
            Btn({ disabled: busy || !allowDangerous, onClick: () => run('cherry-pick', { rev: commit.hash }, 'Cherry-Pick 中…'), children: 'Cherry-Pick' }),
            Btn({ disabled: busy || !allowDangerous, onClick: () => run('reset', { rev: commit.hash, mode: 'soft' }, 'Reset 中…'), children: 'Reset --soft' }),
            Btn({
              kind: 'danger',
              disabled: busy || !allowDangerous,
              onClick: () => ask(`硬重置到 ${commit.shortHash}？会丢弃工作区与暂存区的改动。`, () => run('reset', { rev: commit.hash, mode: 'hard' }, '硬重置中…')),
              children: 'Reset --hard',
            }),
            h(TextInput, {
              inputRef: branchRef,
              style: S.input,
              placeholder: '新分支名（基于此提交创建，不切换）',
              value: commitBranch,
              onChange: (event) => setCommitBranch(event.target.value),
            }),
            Btn({
              kind: 'primary',
              disabled: busy || commitBranch.trim() === '',
              onClick: () => {
                void run('branch/create', { name: commitBranch.trim(), startPoint: commit.hash }, '新建分支中…')
                  .then((value) => { if (value !== null) setCommitBranch('') })
              },
              children: '新建分支',
            }),
          ),
          h('div', { style: S.head }, `变更文件 · ${files.length}　点文件查看它在这次提交里的变更`),
          h('div', { style: S.detailFiles }, files.length === 0
            ? h('div', { style: S.placeholder }, '这次提交没有文件变更')
            : files.map((file) => {
              const isOn = detailFile === file.path
              const isHover = detailHover !== null && detailHover === file.path
              return h('div', {
                key: file.path,
                style: isOn ? { ...S.detailFileRow, ...S.detailFileRowOn } : (isHover ? { ...S.detailFileRow, ...S.rowHover } : S.detailFileRow),
                title: file.path,
                onClick: () => setDetailFile(isOn ? null : file.path),
                onMouseEnter: () => setDetailHover(file.path),
                onMouseLeave: () => setDetailHover((current) => (current === file.path ? null : current)),
              },
                h('span', { style: { ...S.letter, color: STATE_COLORS[file.status.charAt(0)] || STATE_COLORS.M } }, file.status.charAt(0)),
                h('span', { style: S.name }, file.path),
                isOn ? h('span', { style: { ...S.meta, flex: 'none' } }, '收起') : null,
              )
            })),
          h('div', {
            style: S.detailDiff,
            ref: detailBoxRef,
            onScroll: () => syncDiffFocus(filePatch, detailBoxRef, detailLineRefs, detailFocus, setDetailFocus),
          }, detailFile === null
            ? h('div', { style: S.placeholder }, '点上面的文件查看它在这次提交里的变更')
            : (fileLoading === true
              ? h('div', { style: S.placeholder }, Busy({ text: `读取 ${detailFile} 的差异…` }))
              : DiffView({
                text: filePatch,
                loading: false,
                focusRange: detailBlocks.find((block) => block.start === detailFocus) ?? null,
                lineRefs: detailLineRefs,
              }))),
        )
      }

      function renderLogDetail() {
        if (shown === null && showLoading !== true) return null
        const commit = shown === null || shown.commit === null || shown.commit === undefined ? null : shown.commit
        // 文件差异的改动块导航（未选文件时两个箭头都是灰的）。
        const nav = diffNav(filePatch, detailBoxRef, detailLineRefs, setDetailFocus)
        return h('div', { style: { ...S.detailBottom, height: `${detailHeight}px` } },
          h(RowSplitter, {
            height: detailHeight,
            onResize: (next) => setDetailHeight(Math.max(140, Math.min(720, Math.round(next)))),
          }),
          h('div', { style: S.bar },
            h('span', { style: S.meta }, '提交详情'),
            commit === null
              ? null
              : h('span', {
                style: S.hashLink,
                title: `${commit.hash}\n点击复制完整提交 ID`,
                onClick: () => copyText(commit.hash, '提交 ID'),
              }, commit.hash),
            h('span', { style: S.spacer }),
            nav.total === 0 ? null : h('span', { style: { ...S.meta, flex: 'none' } }, diffCountLabel(nav)),
            Btn({ disabled: nav.canPrev !== true, title: '上一个改动', onClick: () => nav.prev(), children: '↑' }),
            Btn({ disabled: nav.canNext !== true, title: '下一个改动', onClick: () => nav.next(), children: '↓' }),
            Btn({ title: '关闭提交详情', onClick: closeDetail, children: '×' }),
          ),
          commit === null ? h('div', { style: S.placeholder }, Busy({ text: '读取提交详情…' })) : renderCommitBody(commit),
        )
      }

      /** 提交哈希 → 指向它的分支标签（本地优先，HEAD 分支置顶）；远程的 origin/HEAD 是符号引用，跳过。 */
      function logTips() {
        const map = new Map()
        const head = repo === null || typeof repo.branch !== 'string' ? '' : repo.branch
        function collect(list, kind) {
          if (!Array.isArray(list)) return
          for (const item of list) {
            if (kind === 'remote' && /(^|\/)HEAD$/.test(item.name) === true) continue
            const key = typeof item.hash === 'string' && item.hash !== '' ? item.hash : item.shortHash
            if (typeof key !== 'string' || key === '') continue
            const label = { name: item.name, kind, head: kind === 'local' && item.name === head }
            const rows = map.get(key)
            if (rows === undefined) map.set(key, [label])
            else rows.push(label)
          }
        }
        collect(branches.local, 'local')
        collect(branches.remote, 'remote')
        for (const rows of map.values()) {
          rows.sort((a, b) => (a.head === b.head ? a.name.localeCompare(b.name) : (a.head === true ? -1 : 1)))
        }
        return map
      }

      /** 取某提交的分支标签：先按完整哈希匹配，取不到再退化到短哈希。 */
      function logLabelsOf(tips, commit) {
        const byHash = tips.get(commit.hash)
        if (byHash !== undefined) return byHash
        const byShort = tips.get(commit.shortHash)
        return byShort === undefined ? [] : byShort
      }

      /** 分支名 → 调色板下标：按名字排序后取模，保证同一分支每次渲染都是同一个颜色。 */
      function logColorByName(tips) {
        const names = []
        for (const rows of tips.values()) {
          for (const label of rows) if (names.includes(label.name) === false) names.push(label.name)
        }
        names.sort((left, right) => left.localeCompare(right))
        const map = new Map()
        for (let index = 0; index < names.length; index++) map.set(names[index], index % GRAPH_COLORS.length)
        return map
      }

      /**
       * 提交树的行布局（每次提交一行），返回 `{ rows, maxLanes }`。
       *
       * 单轨画法（一行一条竖线、颜色随分支变）会把「基于历史提交拉出来的分支」画成当前分支的延续——
       * 真机反馈里那张图就是这个错觉：`test/tree-check` 明明分叉在 19 个提交之前的 cf35637，
       * 画出来却像是从 main 最新提交上长出来的。这里改用 `git log --graph` 的泳道算法：
       *
       *   维护一组泳道，每条泳道记着它**下一个期待的提交**（= 上一条处理过的提交的父提交）。
       *   · 没有泳道期待本提交 → 它是某个分支的 tip，新开一条泳道（线上方不画线）；
       *   · 多条泳道同时期待本提交 → 它们在本行**汇合**（从下往上看，分叉点就在这里）；
       *   · 第一个父提交留在本泳道继续向下，合并提交的其余父提交各开一条新泳道（画分叉斜线）。
       *
       * 于是分叉点画在真正的那次提交上，两条分支各有自己的泳道与颜色，直到汇合行才并成一条。
       * 泳道颜色沿用「分支 tag → 调色板」的映射（当前分支优先），父提交继承子提交泳道的颜色；
       * 没有分支标签的提交（tag-only、detached HEAD）取一个当前没被占用的调色板下标。
       */
      function logLaneLayout(tips, colorByName) {
        const palette = GRAPH_COLORS.length
        /** lanes[i] = { hash, color } | null（null = 空位，可以复用給新泳道）。 */
        const lanes = []
        const rows = new Map()
        let maxLanes = 0

        const freeColor = () => {
          const used = new Set()
          for (const lane of lanes) if (lane !== null) used.add(lane.color)
          for (let index = 0; index < palette; index++) if (used.has(index) === false) return index
          return lanes.length % palette
        }
        /** 提交该用什么颜色：有分支标签就用该分支的色（当前分支优先），否则取一个没人占用的色。 */
        const colorOfCommit = (hash) => {
          let best
          for (const label of tips.get(hash) ?? []) {
            const priority = label.head === true ? 0 : (label.kind === 'local' ? 1 : 2)
            if (best === undefined || priority < best.priority) best = { priority, name: label.name }
          }
          if (best === undefined) return freeColor()
          const index = colorByName.get(best.name)
          return index === undefined ? freeColor() : index
        }
        const allocLane = () => {
          const free = lanes.indexOf(null)
          if (free !== -1) return free
          lanes.push(null)
          return lanes.length - 1
        }

        for (const commit of commits) {
          const before = lanes.slice()
          let lane = -1
          for (let index = 0; index < lanes.length; index++) {
            if (lanes[index] !== null && lanes[index].hash === commit.hash) { lane = index; break }
          }
          /** 同一提交被多条泳道期待：右侧那些泳道在本行汇合到 lane 上。 */
          const merges = []
          let incoming = false
          let color
          if (lane === -1) {
            // 谁都不期待它：分支 tip（或 tag/游离提交），自己开一条泳道，上方不画线。
            lane = allocLane()
            color = colorOfCommit(commit.hash)
          } else {
            incoming = true
            color = lanes[lane].color
            for (let index = lane + 1; index < lanes.length; index++) {
              if (lanes[index] !== null && lanes[index].hash === commit.hash) merges.push(index)
            }
          }
          for (const index of merges) lanes[index] = null

          const parents = Array.isArray(commit.parents) ? commit.parents : []
          const outLanes = []
          lanes[lane] = null
          if (parents.length > 0) {
            // 第一个父提交留在本泳道；合并提交的其余父提交各占一条新泳道。
            lanes[lane] = { hash: parents[0], color }
            for (let index = 1; index < parents.length; index++) {
              const other = allocLane()
              lanes[other] = { hash: parents[index], color }
              outLanes.push(other)
            }
          }

          const laneCount = Math.max(before.length, lanes.length)
          const verticals = []
          for (let index = 0; index < laneCount; index++) {
            if (index === lane) continue
            const was = before[index] === undefined ? null : before[index]
            const now = lanes[index] === undefined ? null : lanes[index]
            // 上下两行期待的仍是同一个提交 = 这条泳道只是路过本行，画一条直行线。
            if (was !== null && now !== null && was.hash === now.hash) {
              verticals.push({ lane: index, kind: 'through', color: was.color })
            }
          }
          if (incoming) verticals.push({ lane, kind: 'up', color: before[lane].color })
          if (parents.length > 0) verticals.push({ lane, kind: 'down', color })

          const diagonals = []
          for (const index of merges) diagonals.push({ from: index, to: lane, dir: 'in', color: before[index].color })
          for (const index of outLanes) diagonals.push({ from: lane, to: index, dir: 'out', color: lanes[index].color })

          maxLanes = Math.max(maxLanes, laneCount)
          rows.set(commit.hash, { lane, color, verticals, diagonals })
        }

        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
        return { rows, maxLanes: Math.max(1, maxLanes, lanes.length) }
      }

      /** 给标签挂上它自己分支的颜色（标签与圆点、连线同色系）。 */
      function logLabelsStyled(tips, commit, colorByName) {
        return logLabelsOf(tips, commit).map((label) => {
          const palette = GRAPH_COLORS[(colorByName.get(label.name) ?? 0) % GRAPH_COLORS.length]
          return { ...label, ring: palette.ring, fill: palette.fill }
        })
      }

      /**
       * 提交树列宽度自适应：泳道区（按最宽行的泳道数）+ 标签区（按最宽一行的分支标签估算）。
       * 上下限 64 / 420，不可拖动。
       */
      function logGraphWidth(layout, tips) {
        let widest = 0
        for (const item of commits) {
          let width = 0
          for (const label of logLabelsOf(tips, item)) width += glyphWidth(label.name) + 16
          if (width > widest) widest = width
        }
        const area = layout.maxLanes * LANE_GAP
        return { area, width: Math.max(64, Math.min(420, Math.round(area + 12 + widest))) }
      }

      /**
       * 提交树的派生数据：标签 → 分支配色 → 泳道布局 → 树列宽度。
       *
       * 这些都是 O(提交数) 的计算，而 hover / 右键菜单每变一次就会重渲染整个 Log（2000 行时
       * 每帧重算一遍布局太亏），所以按引用相等缓存一份。刻意不用 useMemo：renderLog 只在 Log
       * 页签被调用，在它里面挂钩子会让 hook 数量随页签切换变化（React 会直接报错）。
       */
      function logGraphData() {
        const cache = logGraphRef.current
        if (cache !== null && cache.commits === commits && cache.branches === branches && cache.repo === repo) return cache
        /** HEAD 提交：repo.oid 是精确值；拿不到时退回列表首行（git log 由新到旧，首行就是 HEAD）。 */
        const headHash = repo !== null && typeof repo.oid === 'string' && repo.oid !== ''
          ? repo.oid
          : (commits.length === 0 ? null : commits[0].hash)
        const tips = logTips()
        const colorByName = logColorByName(tips)
        const layout = logLaneLayout(tips, colorByName)
        const { area, width } = logGraphWidth(layout, tips)
        const data = {
          commits,
          branches,
          repo,
          headHash,
          tips,
          colorByName,
          layout,
          graphArea: area,
          graphWidth: width,
        }
        logGraphRef.current = data
        return data
      }

      /**
       * Log 视图（列顺序对齐 IDEA）：时间 · 提交树 · Message · Author · Commit。
       * 提交树列自适应且不可拖；其余四列都能拖列宽，message 被拖过之后不再自动填充剩余宽度。
       * 列表滚动到底自动续拉下一页（见 onLogScroll / loadMoreLog）。
       */
      function renderLog() {
        const activeHash = shown === null || shown.commit === null || shown.commit === undefined ? null : shown.commit.hash
        const { headHash, tips, colorByName, layout, graphArea, graphWidth } = logGraphData()
        const rowWidth = logWidths.date + graphWidth + logWidths.message + logWidths.author + logWidths.commit
        const sized = msgAuto !== true
        const rowStyle = sized ? { ...S.tr, width: `${rowWidth}px`, minWidth: '100%' } : S.tr
        const headStyle = sized ? { ...S.thead, width: `${rowWidth}px`, minWidth: '100%' } : S.thead

        function headCell(id, label, width, grow) {
          const box = grow === true
            ? { flex: '1 1 auto', minWidth: `${LOG_LIMITS[id][0]}px` }
            : { flex: `0 0 ${width}px`, width: `${width}px` }
          return h('div', { key: id, style: { ...S.th, ...box } },
            h('span', null, label),
            LOG_LIMITS[id] === undefined ? null : h(ResizeHandle, { width, onResize: (next) => resizeColumn(id, next) }),
          )
        }

        function cell(id, width, content, title, grow) {
          const box = grow === true
            ? { flex: '1 1 auto', minWidth: `${LOG_LIMITS[id][0]}px` }
            : { flex: `0 0 ${width}px`, width: `${width}px` }
          return h('div', { key: id, style: { ...S.td, ...box }, title }, content)
        }

        return h('div', { style: S.bodyStack },
          h('div', { style: S.col, onScroll: onLogScroll },
            h('div', { style: headStyle },
              headCell('date', '时间', logWidths.date),
              headCell('graph', '提交树', graphWidth),
              headCell('message', 'Message', logWidths.message, msgAuto === true),
              headCell('author', 'Author', logWidths.author),
              headCell('commit', 'Commit', logWidths.commit),
            ),
            commits.length === 0
              ? h('div', { style: S.placeholder }, '这个仓库还没有提交')
              : commits.map((item) => {
                const isActive = activeHash !== null && activeHash === item.hash
                const isHover = hoverHash !== null && hoverHash === item.hash
                const isMenuTarget = menu !== null && menu.hash === item.hash
                return h('div', {
                  key: item.hash,
                  style: isActive || isMenuTarget ? { ...rowStyle, ...S.rowOn } : (isHover ? { ...rowStyle, ...S.rowHover } : rowStyle),
                  title: item.subject,
                  onClick: () => openCommit(item.hash),
                  onContextMenu: (event) => openMenu(event, item),
                  onMouseEnter: () => setHoverHash(item.hash),
                  onMouseLeave: () => setHoverHash((current) => (current === item.hash ? null : current)),
                },
                cell('date', logWidths.date, shortDate(item.date), item.date),
                h(GraphCell, {
                  key: 'graph',
                  row: layout.rows.get(item.hash),
                  area: graphArea,
                  filled: headHash !== null && headHash === item.hash,
                  labels: logLabelsStyled(tips, item, colorByName),
                  width: graphWidth,
                }),
                cell('message', logWidths.message, item.subject, item.subject, msgAuto === true),
                cell('author', logWidths.author, item.author, item.author),
                cell('commit', logWidths.commit, h('span', {
                  style: S.hashLink,
                  title: `${item.hash}\n点击复制完整提交 ID`,
                  onClick: (event) => { event.stopPropagation(); copyText(item.hash, '提交 ID') },
                }, item.shortHash)),
                )
              }),
            // 续拉提示：滚动到接近底部会自动拉下一页；到渲染上限只提示一句，不再发请求。
            // 提示行本身也可点 —— 面板很高时 50 行可能撑不出滚动条，那时只剩这一条入口。
            commits.length === 0
              ? null
              : (commits.length >= LOG_MAX_ROWS
                ? h('div', { style: S.placeholder }, `已显示最近 ${LOG_MAX_ROWS} 条提交（含所有分支）`)
                : (logHasMore === true
                  ? h('div', {
                    style: { ...S.placeholder, cursor: 'pointer' },
                    title: '点击立即加载更早的提交',
                    onClick: () => { void loadMoreLog() },
                  }, '滚动到底部继续加载更早的提交…')
                  : null)),
          ),
          renderLogDetail(),
        )
      }

      /* ---------------------------------------------------------- 其它视图 */

      function renderConsole() {
        if (commands.length === 0) return h('div', { style: S.placeholder }, '还没有执行过 git 命令')
        return h('div', { style: S.bodyCol }, commands.map((row, index) => {
          const argv = Array.isArray(row.argv) ? row.argv.join(' ') : String(row.argv)
          const bad = row.exitCode !== 0
          return h('div', {
            key: index,
            style: { ...S.row, alignItems: 'flex-start', whiteSpace: 'normal', cursor: 'default' },
          },
            h('span', { style: { ...S.meta, color: bad ? '#ef4444' : '#22c55e', flex: 'none' } }, row.exitCode === 0 ? '0' : String(row.exitCode)),
            h('span', { style: { ...S.meta, flex: 'none' } }, `${row.durationMs}ms`),
            h('span', { style: { ...S.name, fontFamily: MONO, whiteSpace: 'pre-wrap' } }, argv),
            row.truncated === true ? h('span', { style: { ...S.meta, color: '#ef4444' } }, '（输出被截断）') : null,
            bad && typeof row.stderr === 'string' && row.stderr !== '' ? h('span', { style: { ...S.pre, color: '#ef4444' } }, row.stderr) : null,
          )
        }))
      }

      /** 从某个本地分支的 upstream（形如 origin/main）取出远程名；没有 upstream 时给 origin。 */
      function remoteOfBranch(item) {
        const upstream = typeof item.upstream === 'string' ? item.upstream : ''
        const at = upstream.indexOf('/')
        return at > 0 ? upstream.slice(0, at) : 'origin'
      }

      function renderBranches() {
        const head = repo === null ? '' : repo.branch
        const allowWrite = config === null || config.allowWrite !== false
        const allowDangerous = config === null || config.allowDangerous !== false
        // push 与工具栏同一道门禁（默认关闭），推送入口按分支给出。
        const allowPush = config !== null && config.allowPush === true
        const pushOffTitle = config === null
          ? '插件配置还没读到（等首次快照完成）'
          : 'push 已被插件配置关闭（allowPush=false）'
        function group(title, list, isLocal) {
          return h('div', { key: title },
            h('div', { style: S.head }, `${title} · ${list.length}`),
            list.map((item) => {
              const isHead = isLocal && item.name === head
              const noUpstream = typeof item.upstream !== 'string' || item.upstream === ''
              const remote = remoteOfBranch(item)
              // 与 upstream 的领先 / 落后提交数（解析自 for-each-ref 的 %(upstream:track)）。
              const ahead = typeof item.ahead === 'number' ? item.ahead : 0
              const behind = typeof item.behind === 'number' ? item.behind : 0
              const rowKey = `${item.kind}:${item.name}`
              const over = hoverBranch !== null && hoverBranch === rowKey
              // 行本身不是可点区域（操作都在行内按钮上），所以不给 pointer 光标，也不做"选中"高亮：
              // 当前分支只用首列 `*` 与绿色分支名标识，行的背景只在 hover 时变化。
              const base = { ...S.row, cursor: 'default' }
              return h('div', {
                key: rowKey,
                style: over ? { ...base, ...S.rowHover } : base,
                title: item.subject,
                onMouseEnter: () => setHoverBranch(rowKey),
                onMouseLeave: () => setHoverBranch((current) => (current === rowKey ? null : current)),
              },
                h('span', { style: { ...S.letter, color: isHead ? '#22c55e' : '#9ca3af' } }, isHead ? '*' : '+'),
                h('span', { style: isHead ? { ...S.name, color: '#22c55e', fontWeight: 600 } : S.name }, item.name),
                item.upstream === '' ? null : h('span', { style: S.dir }, ` → ${item.upstream}`),
                // 领先 / 落后远程的提交数：只在有差异时显示（绿=领先待推送，红=落后待拉取）。
                noUpstream === true || (ahead === 0 && behind === 0) ? null : h('span', {
                  style: { ...S.meta, flex: 'none', marginLeft: '6px' },
                  title: `相对 ${item.upstream}：领先 ${ahead} 个提交，落后 ${behind} 个提交`,
                },
                  ahead > 0 ? h('span', { style: { color: '#22c55e' } }, `↑${ahead}`) : null,
                  ahead > 0 && behind > 0 ? ' ' : null,
                  behind > 0 ? h('span', { style: { color: '#ef4444' } }, `↓${behind}`) : null,
                ),
                h('span', { style: S.spacer }),
                // 推送：本地分支才有意义；没有 upstream 时走 --set-upstream，省得回终端设跟踪关系。
                isLocal ? Btn({
                  kind: 'primary',
                  disabled: busy || allowPush !== true,
                  title: allowPush !== true
                    ? pushOffTitle
                    : (noUpstream ? `git push --set-upstream ${remote} ${item.name}` : `git push ${remote} ${item.name}`),
                  onClick: () => pushWithAuth(
                    noUpstream ? { branch: item.name, remote, setUpstream: true } : { branch: item.name, remote },
                    noUpstream ? '推送并设置 upstream 中…' : '推送中…',
                    remote,
                  ),
                  children: noUpstream ? '推送并设 upstream' : '推送',
                }) : null,
                isHead ? null : Btn({ disabled: busy || !allowWrite, onClick: () => run('checkout', { ref: item.name }, '切换分支中…'), children: '切换' }),
                isHead ? null : Btn({ disabled: busy || !allowWrite, onClick: () => run('merge', { ref: item.name }, '合并中…'), children: '合并' }),
                isLocal && !isHead ? Btn({
                  kind: 'danger',
                  disabled: busy || !allowDangerous,
                  onClick: () => ask(`删除分支 ${item.name}？未合并的提交会丢失。`, () => run('branch/delete', { name: item.name, force: true }, '删除分支中…')),
                  children: '删除',
                }) : null,
              )
            }),
          )
        }
        return h('div', { style: S.bodyCol },
          h('div', { style: S.bar },
            h(TextInput, {
              style: S.input,
              placeholder: '新分支名（基于当前 HEAD，新建并切换）',
              value: newBranch,
              onChange: (event) => setNewBranch(event.target.value),
            }),
            Btn({
              kind: 'primary',
              disabled: busy || !allowWrite || newBranch.trim() === '',
              onClick: () => {
                void run('checkout', { ref: newBranch.trim(), create: true }, '新建分支中…')
                  .then((value) => { if (value !== null) setNewBranch('') })
              },
              children: '新建并切换',
            }),
          ),
          // 需要认证时才出现的行内表单：填一次存进 git 凭据，之后推送就不用再管了。
          authFor === null ? null : h('div', { style: S.bar },
            h('span', { style: { ...S.dir, flex: 'none' } }, `认证 · ${authFor.remoteName}：`),
            h('span', { style: { ...S.meta, flex: 1, minWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: authFor.url },
              authFor.url === '' ? '读取远程地址…' : authFor.url),
            h(TextInput, {
              style: { ...S.input, flex: 'none', width: '96px' },
              placeholder: '用户名',
              spellCheck: false,
              value: authUser,
              onChange: (event) => setAuthUser(event.target.value),
            }),
            h(TextInput, {
              style: { ...S.input, flex: 'none', width: '120px' },
              type: 'password',
              placeholder: '密码 / Token',
              spellCheck: false,
              value: authSecret,
              onChange: (event) => setAuthSecret(event.target.value),
            }),
            Btn({
              kind: 'primary',
              disabled: authSaving || authUser.trim() === '' || authSecret === '',
              title: '保存到 git 凭据（credential.helper），保存后自动重推',
              onClick: () => { void saveCredential() },
              children: authSaving ? '保存中…' : '保存并推送',
            }),
            Btn({
              disabled: authSaving,
              onClick: () => { setAuthFor(null); setAuthSecret('') },
              children: '取消',
            }),
          ),
          group('本地分支', branches.local, true),
          group('远程分支', branches.remote, false),
        )
      }

      function renderRemotes() {
        const list = remotes === null ? [] : remotes
        const allowWrite = config === null || config.allowWrite !== false
        if (remoteLoading || remotes === null) return h('div', { style: S.placeholder }, Busy({ text: '读取远程仓库（git remote -v）…' }))
        return h('div', { style: S.bodyCol },
          h('div', { style: S.bar },
            h(TextInput, {
              style: { ...S.input, flex: 'none', width: '110px' },
              placeholder: 'Remote 名',
              spellCheck: false,
              value: remoteName,
              onChange: (event) => setRemoteName(event.target.value),
            }),
            h(TextInput, {
              style: S.input,
              placeholder: 'URL（fetch）',
              spellCheck: false,
              value: remoteUrl,
              onChange: (event) => setRemoteUrl(event.target.value),
            }),
            h(TextInput, {
              style: S.input,
              placeholder: 'Push URL（可选，留空 = 与 fetch 相同）',
              spellCheck: false,
              value: remotePush,
              onChange: (event) => setRemotePush(event.target.value),
            }),
            // 需要认证的远程可以在这里就把账号密码/Token 一起给上：添加时即认证，之后 push 不用再填。
            h(TextInput, {
              style: { ...S.input, flex: 'none', width: '100px' },
              placeholder: '用户名（可选）',
              spellCheck: false,
              value: remoteUser,
              onChange: (event) => setRemoteUser(event.target.value),
            }),
            h(TextInput, {
              style: { ...S.input, flex: 'none', width: '120px' },
              type: 'password',
              placeholder: '密码 / Token（可选）',
              spellCheck: false,
              value: remoteSecret,
              onChange: (event) => setRemoteSecret(event.target.value),
            }),
            Btn({
              kind: 'primary',
              disabled: busy || !allowWrite || remoteName.trim() === '' || remoteUrl.trim() === '',
              title: !allowWrite ? '写操作已被插件配置关闭（allowWrite=false）' : undefined,
              onClick: () => {
                const name = remoteName.trim()
                const url = remoteUrl.trim()
                const push = remotePush.trim()
                const user = remoteUser.trim()
                const payload = {
                  name,
                  url,
                  ...(push === '' ? {} : { push }),
                  ...(user === '' || remoteSecret === '' ? {} : { username: user, secret: remoteSecret }),
                }
                void run('remote/add', payload, '添加远程中…').then((value) => {
                  if (value !== null) {
                    setRemoteName('')
                    setRemoteUrl('')
                    setRemotePush('')
                    setRemoteUser('')
                    setRemoteSecret('')
                    // 触发 Remotes 页 useEffect 重拉列表
                    setTick((n) => n + 1)
                  }
                })
              },
              children: 'Add Remote',
            }),
          ),
          list.length === 0 ? h('div', { style: S.head }, '没有配置任何远程仓库（git remote -v 为空）') : h('div', { style: S.head }, `远程仓库 · ${list.length}`),
          list.map((item) => h('div', { key: item.name, style: S.remoteRow },
            h('span', { style: { ...S.letter, color: '#3b82f6', flex: 'none' } }, '◆'),
            h('div', { style: S.remoteCol },
              h('span', { style: S.name }, item.name),
              h('span', { style: { ...S.meta, ...S.wrap } }, `fetch: ${item.fetch === '' ? '—' : item.fetch}`),
              h('span', { style: { ...S.meta, ...S.wrap } }, `push:  ${item.push === '' ? '—' : item.push}`),
            ),
            h('span', { style: S.spacer }),
            Btn({
              kind: 'danger',
              disabled: busy || !allowWrite,
              title: !allowWrite ? '写操作已被插件配置关闭（allowWrite=false）' : '删除远程',
              onClick: () => ask(`删除远程 ${item.name}？此操作不会影响本地分支。`, () => run('remote/remove', { name: item.name }, '删除远程中…').then((value) => {
                if (value !== null) setTick((n) => n + 1)
              })),
              children: 'Remove',
            }),
          )),
        )
      }

      function renderStash() {
        const allowWrite = config === null || config.allowWrite !== false
        return h('div', { style: S.bodyCol },
          h('div', { style: S.bar },
            h(TextInput, {
              style: S.input,
              placeholder: '贮藏说明',
              value: stashMessage,
              onChange: (event) => setStashMessage(event.target.value),
            }),
            Btn({
              kind: 'primary',
              disabled: busy || !allowWrite,
              title: '贮藏（git stash push）：把当前未提交的改动整体收起来',
              onClick: () => {
                void run('stash', { action: 'push', message: stashMessage }, '贮藏中…').then((value) => {
                  if (value !== null) setStashMessage('')
                })
              },
              children: '贮藏当前改动',
            }),
            Btn({
              disabled: busy || stashMessage === '',
              title: '清空说明输入框',
              onClick: () => setStashMessage(''),
              children: '清空',
            }),
          ),
          stashes.length === 0 ? h('div', { style: S.head }, '还没有贮藏记录') : null,
          stashes.map((item) => h('div', { key: item.ref, style: S.row, title: item.date },
            h('span', { style: { ...S.meta, flex: 'none' } }, item.ref),
            h('span', { style: S.name }, item.subject),
            h('span', { style: S.spacer }),
            Btn({
              disabled: busy || !allowWrite,
              title: '应用（git stash apply）：取回改动，但保留这条贮藏记录',
              onClick: () => run('stash', { action: 'apply', ref: item.ref }, '应用贮藏中…'),
              children: '应用',
            }),
            Btn({
              disabled: busy || !allowWrite,
              title: '弹出（git stash pop）：取回改动，并删掉这条贮藏记录',
              onClick: () => run('stash', { action: 'pop', ref: item.ref }, '弹出贮藏中…'),
              children: '弹出',
            }),
            Btn({
              kind: 'danger',
              disabled: busy || !allowWrite,
              title: '删除（git stash drop）：丢弃这条贮藏记录，改动无法再取回',
              onClick: () => ask(`删除贮藏 ${item.ref}？这条记录里的改动将无法取回。`, () => run('stash', { action: 'drop', ref: item.ref }, '删除贮藏中…')),
              children: '删除',
            }),
          )),
        )
      }

      /**
       * 非 git 仓库时的整页空态：一个居中的 Git 图标 + 说明 + 唯一的按钮。
       * 只保留最上面的路径栏（否则换个目录都换不了），其余功能一律不渲染。
       */
      function renderNoRepo() {
        return h('div', { style: S.noRepo },
          h('div', { style: S.noRepoIcon }, h(GitGlyph, { size: 34 })),
          h('div', { style: S.noRepoTitle }, '当前目录不是 Git 仓库'),
          h('div', { style: S.noRepoPath, title: applied }, applied === '' ? '（未选择目录）' : applied),
          Btn({
            kind: 'primary',
            style: S.buttonBig,
            disabled: initBusy || applied === '' || (config !== null && config.allowWrite === false),
            title: config !== null && config.allowWrite === false
              ? '写操作已被插件配置关闭（allowWrite=false）'
              : '在当前目录执行 git init',
            onClick: () => { void initRepo() },
            children: initBusy ? Busy({ text: '正在初始化…' }) : '在当前目录初始化 Git 仓库',
          }),
          h('div', { style: S.noRepoHint },
            config !== null && config.allowWrite === false
              ? '插件配置里 allowWrite=false，已禁用初始化。'
              : '会在该目录执行 git init 并创建初始分支（取 git 的 init.defaultBranch，未配置时为 main）。完成后这里就会显示本地变更、提交、历史等面板。'),
        )
      }

      const TABS = [
        { id: 'changes', label: 'Local Changes' },
        { id: 'log', label: 'Log' },
        { id: 'console', label: 'Console' },
        { id: 'branches', label: 'Branches' },
        { id: 'remotes', label: 'Remotes' },
        { id: 'stash', label: 'Stash' },
      ]

      const branchLabel = repo === null ? '（未加载）' : (repo.detached === true ? 'DETACHED' : repo.branch)
      /** 当前分支的 upstream 属于哪个远程（Push / 凭据按钮用），拿不到就 origin。 */
      const upstreamRemote = repo !== null && typeof repo.upstream === 'string' && repo.upstream.includes('/')
        ? repo.upstream.slice(0, repo.upstream.indexOf('/'))
        : 'origin'

      return h('div', { style: S.root, ref: rootRef },
        busy ? h('div', { style: S.busyBar }) : null,
        h('div', { style: S.bar },
          h(TextInput, {
            style: S.input,
            placeholder: '仓库路径（会话工作目录）',
            spellCheck: false,
            value: cwd,
            onChange: (event) => setCwd(event.target.value),
          }),
          Btn({
            disabled: busy || cwd.trim() === '',
            // 路径没变时 setApplied 不会触发 effect（依赖没变），只点「打开仓库」将毫无反应 ——
            // 这种情况改成踢一次 tick，语义就是"重新读一遍这个目录"。
            onClick: () => {
              logLoadedRef.current = 0
              closeDetail()
              if (cwd.trim() === applied) setTick((n) => n + 1)
              else setApplied(cwd.trim())
            },
            children: '打开仓库',
          }),
        ),
        // 非仓库：只留路径栏 + 居中空态，分支栏 / 工具按钮 / 页签 / 正文全部不渲染。
        noRepo === true ? renderNoRepo() : h('div', { style: S.paneCol },
        h('div', { style: S.bar },
          h('button', { style: S.chip, title: '查看 / 切换分支', onClick: () => setTab('branches') },
            h(GitGlyph, { size: 14 }),
            branchLabel,
          ),
          repo === null || (repo.ahead === 0 && repo.behind === 0) ? null : h('span', { style: S.meta }, `↑${repo.ahead} ↓${repo.behind}`),
          h('span', { style: S.spacer }),
          Btn({ disabled: busy || applied === '', onClick: () => setTick((n) => n + 1), children: 'Refresh' }),
          Btn({ disabled: busy || applied === '' || config !== null && config.allowWrite === false, onClick: () => run('fetch', {}, 'Fetch 中…'), children: 'Fetch' }),
          Btn({ disabled: busy || applied === '' || config !== null && config.allowWrite === false, onClick: () => run('pull', {}, 'Update Project 中…'), children: 'Update Project' }),
          Btn({
            disabled: busy || applied === '' || config === null || config.allowPush !== true,
            title: config !== null && config.allowPush !== true ? 'push 已被插件配置关闭（allowPush=false）' : '推送到远程',
            onClick: () => pushWithAuth({}, 'Push 中…', upstreamRemote),
            children: 'Push',
          }),
          Btn({
            disabled: busy || applied === '' || upstreamRemote === '',
            title: `配置 ${upstreamRemote} 的认证信息（用户名 + 密码/Token，存进 git 凭据）`,
            onClick: () => { setAuthSecret(''); setAuthFor({ remoteName: upstreamRemote, payload: undefined, label: '', url: '' }) },
            children: '凭据',
          }),
        ),
        notice === null ? null : h('div', { style: notice.bad === true ? { ...S.toast, ...S.toastBad } : S.toast }, notice.text),
        h('div', { style: S.tabs }, TABS.map((item) => h('button', {
          key: item.id,
          style: tab === item.id ? { ...S.tab, ...S.tabOn } : S.tab,
          onClick: () => setTab(item.id),
        }, item.label))),
        loading
          ? h('div', { style: S.placeholder }, applied === ''
            ? '填写仓库路径后点「打开仓库」（默认取当前会话工作目录）'
            : Busy({ text: '正在读取仓库（status / log / branches / stash）…' }))
          : h('div', { style: { ...S.bodyCol, display: 'flex', flexDirection: 'column' } },
            tab === 'changes' ? renderChanges() : null,
            tab === 'log' ? renderLog() : null,
            tab === 'console' ? renderConsole() : null,
            tab === 'branches' ? renderBranches() : null,
            tab === 'remotes' ? renderRemotes() : null,
            tab === 'stash' ? renderStash() : null,
            tab === 'changes' ? renderCommitBox() : null,
          ),
        ),
        confirm === null ? null : h('div', { style: S.confirm },
          h('span', { style: S.spacer }, confirm.label),
          Btn({
            kind: 'danger',
            onClick: () => { const job = confirm.run; setConfirm(null); void job() },
            children: '确认执行',
          }),
          Btn({ onClick: () => setConfirm(null), children: '取消' }),
        ),
        // 底部状态栏只留"正在做什么"：仓库路径在顶部输入框、改动数在各分组标题、命令流水在 Console 页、
        // 单次操作耗时在完成 toast 里，都能看到，不必再重复一行。
        busy ? h('div', { style: S.foot }, Busy({ text: busyLabel === '' ? '处理中…' : busyLabel })) : null,
        renderMenu(),
      )
    }

    /** tab chip 与浮窗标题：单行不折行、给足最小宽度，避免被裁。 */
    function GitTitle() {
      return h('span', { style: S.title }, h(GitGlyph, { size: 14 }), h('span', null, '版本管理'))
    }

    /* --------------------------------------------------------------- 插件入口 */

    /**
     * 浏览器半区必需的 Cordis 服务：
     *   slots            —— 注册 tab 正文与标题（sidebar.right.pane.tab / .title）
     *   sidebarRightTabs —— 注册 tab 类型与引导页入口
     *   connection       —— 调 host 的 /git-vcs RPC 通道
     */
    const inject = ['slots', 'sidebarRightTabs', 'connection']

    /**
     * 注册：类型（阶段一）、正文（阶段二）、标题（阶段三）。
     * 分栏 / 全屏 / 浮窗由 ui-sidebar-right + dockkit 提供，本包不碰布局。
     * @param ctx - 客户端根 context。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: PKG_ID,
        kind: KIND,
        title: () => '版本管理',
        guide: [{
          order: 20,
          title: () => '版本管理',
          description: () => '参照 IDEA 的版本管理：本地变更、提交、历史、分支、远程与命令流水',
          icon: GitGlyph,
        }],
      }), 'dsh-git-vcs: tab type')

      // 组件拿不到 ctx：host 调用经注入工厂闭包捕获后交给组件。
      const face = () => ({
        call: (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload),
      })

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PKG_ID,
        inject: face,
      }, GitBody)), 'dsh-git-vcs: tab body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: PKG_ID,
      }, GitTitle)), 'dsh-git-vcs: tab title')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
