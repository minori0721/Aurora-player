export function createDom({} = {}) {
    const el = {
        img: document.getElementById('album-img'), coverWrap: document.getElementById('cover-wrap'), coverImages: document.getElementById('cover-images'),
        title: document.getElementById('track-title'), artist: document.getElementById('track-artist'),
        lyricBox: document.getElementById('lyrics-content'),
        progBg: document.getElementById('prog-bg'), progLine: document.getElementById('prog-line'), bufferLine: document.getElementById('buffer-line'),
        currTime: document.getElementById('curr-time'), totalTime: document.getElementById('total-time'),
        plContainer: document.getElementById('pl-container'), plSidebar: document.getElementById('playlist-sidebar'),
        plItems: document.getElementById('playlist-items'), plTemporary: document.getElementById('pl-temporary'),
        plTemporaryContainer: document.getElementById('pl-temporary-container'), plBaseLabel: document.getElementById('pl-base-label'),
        plClearTemporary: document.getElementById('pl-clear-temporary'),
        plSearch: document.getElementById('pl-search'), plSearchClear: document.getElementById('pl-search-clear'),
        plSearchEmpty: document.getElementById('pl-search-empty'),
        plScrollCurrent: document.getElementById('pl-scroll-current'), plScrollTop: document.getElementById('pl-scroll-top'),
        playBtn: document.getElementById('play-btn'),
        effectSel: document.getElementById('effect-select'), canvas: document.getElementById('visual-canvas'),
        loopPanel: document.getElementById('loop-panel'), loopStart: document.getElementById('loop-start'), loopEnd: document.getElementById('loop-end'), loopEnable: document.getElementById('loop-enable'),
        baseRateInput: document.getElementById('base-rate'), loopMsg: document.getElementById('loop-msg'),
        markerA: document.getElementById('marker-a'), markerB: document.getElementById('marker-b'),
        modeBtn: document.getElementById('mode-btn'), loadTip: document.getElementById('loading-tip'),
        volBtn: document.getElementById('vol-btn'), volPopup: document.getElementById('vol-popup'), volRange: document.getElementById('vol-range'),
        // Analyze UI
        anaPanel: document.getElementById('analyze-panel'), anaStart: document.getElementById('ana-start'), anaEnd: document.getElementById('ana-end'), anaMode: document.getElementById('ana-mode'), anaRun: document.getElementById('ana-run'), anaMsg: document.getElementById('ana-msg'),
        anaResult: document.getElementById('ana-result'), anaDetails: document.getElementById('ana-details'),
        anaApply: document.getElementById('ana-apply'), anaRestore: document.getElementById('ana-restore')
    };

    // 下载 UI 元素
    const downloadBtn = document.getElementById('download-btn');

    const downloadBtnMobile = document.getElementById('download-btn-mobile');

    const downloadModal = document.getElementById('download-modal');

    const downloadClose = document.getElementById('download-close');

    const downloadCancel = document.getElementById('download-cancel');

    const downloadListEl = document.getElementById('download-list');

    const downloadTitle = document.getElementById('download-title');

    const downloadTrackInfo = document.getElementById('download-track-info');

    const lyricToggleBtn = document.getElementById('lyric-toggle-btn');

    const fileInput = document.getElementById('file-input');

    const dragMaskTitle = document.getElementById('drag-mask-title');

    const dragMaskDetail = document.getElementById('drag-mask-detail');

    const importSummary = document.getElementById('import-summary');

    // ========== 网易云音乐搜索 & 歌单导入 ==========
    const neteasePanel = document.getElementById('netease-panel');

    const neteaseTabs = document.querySelectorAll('.netease-tab');

    const searchInput = document.getElementById('netease-search-input');

    const searchBtn = document.getElementById('netease-search-btn');

    const searchResults = document.getElementById('netease-search-results');

    const playlistInput = document.getElementById('netease-playlist-input');

    const playlistBtn = document.getElementById('netease-playlist-btn');

    const playlistPreview = document.getElementById('netease-playlist-preview');

    const playlistResults = document.getElementById('netease-playlist-results');

    const neteaseBrowserScroll = document.getElementById('netease-browser-scroll');

    const neteaseBrowserView = document.getElementById('netease-browser-view');

    const neteasePageTitle = document.getElementById('netease-page-title');

    // 初始化音质选择器
    const qualitySelect = document.getElementById('netease-quality-select');

    // 移动端高级菜单
    const advancedBtn = document.getElementById('toggle-advanced');

    const advancedMenu = document.getElementById('advanced-menu');
    const cloudLyricsSwitches = ['cloud-lyrics-switch', 'cloud-lyrics-switch-desktop'].map(id => document.getElementById(id)).filter(Boolean);
    const lyricModeInputs = ['original', 'both', 'roma'].map(mode => document.getElementById(`lyric-mode-${mode}`)).filter(Boolean);

    return {
        get el() { return el; },
        get downloadBtn() { return downloadBtn; },
        get downloadBtnMobile() { return downloadBtnMobile; },
        get downloadModal() { return downloadModal; },
        get downloadClose() { return downloadClose; },
        get downloadCancel() { return downloadCancel; },
        get downloadListEl() { return downloadListEl; },
        get downloadTitle() { return downloadTitle; },
        get downloadTrackInfo() { return downloadTrackInfo; },
        get lyricToggleBtn() { return lyricToggleBtn; },
        get fileInput() { return fileInput; },
        get dragMaskTitle() { return dragMaskTitle; },
        get dragMaskDetail() { return dragMaskDetail; },
        get importSummary() { return importSummary; },
        get neteasePanel() { return neteasePanel; },
        get neteaseTabs() { return neteaseTabs; },
        get searchInput() { return searchInput; },
        get searchBtn() { return searchBtn; },
        get searchResults() { return searchResults; },
        get playlistInput() { return playlistInput; },
        get playlistBtn() { return playlistBtn; },
        get playlistPreview() { return playlistPreview; },
        get playlistResults() { return playlistResults; },
        get neteaseBrowserScroll() { return neteaseBrowserScroll; },
        get neteaseBrowserView() { return neteaseBrowserView; },
        get neteasePageTitle() { return neteasePageTitle; },
        get qualitySelect() { return qualitySelect; },
        get advancedBtn() { return advancedBtn; },
        get advancedMenu() { return advancedMenu; },
        get cloudLyricsSwitches() { return cloudLyricsSwitches; },
        get lyricModeInputs() { return lyricModeInputs; }
    };
}
