import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtQuick.Shapes
import QtCore
import QtWebEngine
import "../shell"

// Navegador: the NEXUS web browser. Chromium's engine (QtWebEngine) inside a NEXUS window: tabs, an address bar that
// searches with NEXUS Search (browser/search.html: your apps, files and visited pages + the web via NEXUS AI) and
// understands developer shortcuts (gh/so/mdn/npm/pypi, localhost:3000), developer tools, find, zoom, downloads to
// ~/Descargas, and a NEXUS AI side panel that answers about the page (sent to the Engine as the website's words, with
// no tools: core/src/os.ts pageMessage). Started by `nexus-app Browser [address]`.
Window {
    id: w
    visible: true
    width: 1240; height: 780
    minimumWidth: 720; minimumHeight: 460
    title: "Navegador"
    color: Theme.bg

    readonly property string home: String(StandardPaths.writableLocation(StandardPaths.HomeLocation)).replace("file://", "")
    readonly property string dataDir: String(StandardPaths.writableLocation(StandardPaths.GenericDataLocation)).replace("file://", "")
    readonly property string cacheDir: String(StandardPaths.writableLocation(StandardPaths.GenericCacheLocation)).replace("file://", "")
    readonly property url newTabUrl: Qt.resolvedUrl("../browser/newtab.html") + (Theme.dark ? "" : "?theme=light")
    readonly property var bangs: ({ gh: "https://github.com/search?type=repositories&q=", so: "https://stackoverflow.com/search?q=",
                                    mdn: "https://developer.mozilla.org/es/search?q=", npm: "https://www.npmjs.com/search?q=",
                                    pypi: "https://pypi.org/search/?q=" })
    property var tabs: []
    property var current: null
    property bool devOpen: false
    property bool aiOpen: false
    property bool findOpen: false
    property string hovered: ""
    property string toastText: ""

    // ------------------------------------------------------------------ addresses
    function isNewTab(u) { return String(u).indexOf("/nexus/browser/newtab.html") >= 0 }
    // NEXUS Search: our own results page (browser/search.html), filled in from nexus-sessiond (core/src/search.ts)
    readonly property string searchPage: String(Qt.resolvedUrl("../browser/search.html"))
    function isSearch(u) { return String(u).indexOf(searchPage) === 0 }
    function searchQuery(u) {
        var m = /[?&]q=([^&#]*)/.exec(String(u))
        try { return m ? decodeURIComponent(m[1].replace(/\+/g, " ")).trim() : "" } catch (e) { return "" }
    }
    function searchUrl(q) { return searchPage + "?q=" + encodeURIComponent(q) + (Theme.dark ? "" : "&theme=light") }
    function shownUrl(u) {
        var s = String(u || "")
        if (!s || isNewTab(s) || s === "about:blank") return ""
        if (isSearch(s)) return searchQuery(s)
        return s.replace(/^https:\/\//, "").replace(/\/$/, "")
    }
    function toUrl(t) {   // same rules as browser/newtab.html
        t = String(t).trim(); if (!t) return ""
        var m = /^(gh|so|mdn|npm|pypi)\s+(.+)$/i.exec(t)
        if (m) return bangs[m[1].toLowerCase()] + encodeURIComponent(m[2])
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|view-source):/i.test(t)) return t
        if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(t)) return "http://" + t
        if (!/\s/.test(t) && /^[^\/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return "https://" + t
        return searchUrl(t)
    }
    function insecure(u) {
        var s = String(u || "")
        return /^http:\/\//i.test(s) && !/^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:\/]|$)/i.test(s)
    }

    // ------------------------------------------------------------------ tabs
    function addTab(address) {
        var v = tabComp.createObject(pages, { profile: profile })
        var t = tabs.slice(); t.push(v); tabs = t
        current = v
        v.url = address ? toUrl(address) : newTabUrl
        if (!address) addr.forceActiveFocus()
        return v
    }
    function closeTab(v) {
        var i = tabs.indexOf(v); if (i < 0) return
        var t = tabs.slice(); t.splice(i, 1)
        if (!t.length) { w.close(); return }
        tabs = t
        if (current === v) current = t[Math.min(i, t.length - 1)]
        v.destroy()
    }
    function cycle(step) { if (tabs.length > 1) current = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length] }
    function go(text) { var u = toUrl(text); if (u && current) { current.url = u; current.forceActiveFocus() } }
    function toast(t) { toastText = t; toastTimer.restart() }
    // "Servidores en marcha" on the new tab: sessiond lists this user's localhost servers (core/src/ports.ts)
    function feedServers() {
        var v = current
        if (!v || !isNewTab(v.url) || v.loading) return
        Session.request("GET", "/ports", null, function(st, j) {
            if (st === 200 && j && w.current === v && w.isNewTab(v.url)) v.runJavaScript("document.documentElement.classList.toggle('light', " + !Theme.dark + "); window.nexusServers && window.nexusServers(" + JSON.stringify(j.servers || []) + ")")
        })
        Session.request("GET", "/search/frequent", null, function(st, j) {
            if (st === 200 && j && w.current === v && w.isNewTab(v.url)) v.runJavaScript("window.nexusFrequent && window.nexusFrequent(" + JSON.stringify(j.pages || []) + ")")
        })
    }

    // ------------------------------------------------------------------ address bar suggestions (like Safari)
    property string typed: ""        // what they typed, without the completed part
    property int typedLen: 0
    property bool completeOk: false  // only while the text grows: Backspace must be able to remove the completion
    property var sugg: []
    property string suggFor: ""
    property int suggAt: 0
    readonly property bool suggOpen: addr.activeFocus && sugg.length > 0 && typed.trim() !== ""
    Timer { id: suggTimer; interval: 60; onTriggered: w.askSuggestions() }
    function looksLikeAddress(t) {
        t = String(t).trim()
        return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t) || (!/\s/.test(t) && /^[^\/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t))
    }
    function typing(text) {
        completeOk = text.length > typedLen
        typed = text; typedLen = text.length
        if (!text.trim()) { sugg = []; return }
        suggTimer.restart()
    }
    function askSuggestions() {
        var q = typed, t = q.trim()
        Session.request("GET", "/search/suggest?q=" + encodeURIComponent(t), null, function(st, j) {
            if (st !== 200 || !j || q !== w.typed || !addr.activeFocus) return
            var rows = []
            var top = j.top && !/\s/.test(t) ? j.top : null
            var starts = !!top && String(top.completion).toLowerCase().indexOf(t.toLowerCase()) === 0
            if (top) rows.push({ kind: "top", title: top.completion, sub: top.title || "Visitada antes", url: top.url })
            rows.push({ kind: "go", title: t, sub: w.looksLikeAddress(t) ? "Ir a esta dirección" : "Buscar con NEXUS Search" })
            var i
            for (i = 0; i < Math.min(4, (j.phrases || []).length); i++) rows.push({ kind: "phrase", title: j.phrases[i], sub: "" })
            for (i = 0; i < Math.min(3, (j.pages || []).length); i++) rows.push({ kind: "page", title: j.pages[i].title || j.pages[i].host, sub: j.pages[i].host, url: j.pages[i].url })
            for (i = 0; i < (j.apps || []).length; i++) rows.push({ kind: "app", title: j.apps[i].name, sub: "App", app: j.apps[i].id })
            for (i = 0; i < (j.settings || []).length; i++) rows.push({ kind: "setting", title: j.settings[i].title, sub: "Ajustes", page: j.settings[i].page })
            w.sugg = rows; w.suggFor = q
            // Safari: the site is completed inline and the added part stays selected (typing on replaces it)
            if (starts && w.completeOk && q === t && addr.text === q && top.completion.length > q.length) {
                addr.text = q + top.completion.slice(q.length)
                addr.select(q.length, addr.text.length)
                w.suggAt = 0
            } else w.suggAt = top ? 1 : 0
        })
    }
    function pick(row) {
        sugg = []
        if (row.kind === "top" || row.kind === "page") { if (current) { current.url = row.url; current.forceActiveFocus() } }
        else if (row.kind === "phrase") { if (current) { current.url = searchUrl(row.title); current.forceActiveFocus() } }
        else if (row.kind === "app") { Session.launch(row.app); if (current) current.forceActiveFocus() }
        else if (row.kind === "setting") { Session.openSettings(row.page); if (current) current.forceActiveFocus() }
        else go(row.title)
    }
    function enterAddress() {
        // the rows only count if they belong to what is typed now (Enter can come before they arrive)
        if (suggOpen && suggFor === typed && suggAt >= 0 && suggAt < sugg.length) pick(sugg[suggAt])
        else { sugg = []; go(addr.text) }
    }

    // ------------------------------------------------------------------ NEXUS Search
    // The results page asks for nothing itself: this fills it in, only while that tab still shows that search.
    function feedSearch(v, webMode) {
        var q = searchQuery(v.url)
        if (!q) return
        var js = function(fn, data) {
            if (w.isSearch(v.url) && w.searchQuery(v.url) === q)
                v.runJavaScript("window." + fn + " && window." + fn + "(" + JSON.stringify(data) + ", " + JSON.stringify(q) + ")")
        }
        Session.request("GET", "/search?q=" + encodeURIComponent(q), null, function(st, j) {
            if (st !== 200 || !j) return
            js("nexusLocal", j)
            var mode = webMode || j.web
            // the results themselves: at once, from the person's search service (or Wikipedia), plus the calculator
            Session.request("GET", "/search/results?q=" + encodeURIComponent(q), null, function(s3, r) {
                var res = s3 === 200 && r ? r : null
                if (res) js("nexusResults", res)
                if (mode === "off") { js("nexusWebState", "off"); js("nexusWiki", null); return }
                Session.request("GET", "/search/wiki?q=" + encodeURIComponent(q), null, function(s2, k) { if (s2 === 200 && k) js("nexusWiki", k.card) })
                if (res && res.full) {            // the list is on screen: NEXUS AI only writes the short answer from it
                    if (mode === "auto") w.searchAnswer(v, q)
                    else js("nexusWebState", "manual-answer")
                } else if (mode === "auto") w.searchWeb(v, q)   // no search service yet: Claude does the whole search
                else js("nexusWebState", "manual")
            })
        })
    }
    // The short answer from the results already on screen (about a second, a tenth of a cent)
    function searchAnswer(v, q) {
        var js = function(fn, data) {
            if (w.isSearch(v.url) && w.searchQuery(v.url) === q)
                v.runJavaScript("window." + fn + " && window." + fn + "(" + JSON.stringify(data) + ", " + JSON.stringify(q) + ")")
        }
        js("nexusWebState", "answering")
        Session.request("GET", "/search/answer?q=" + encodeURIComponent(q), null, function(st, j) {
            js("nexusAnswer", st === 200 && j ? j : { error: j && j.error ? j.error : st === 0 ? "offline" : "error" })
        })
    }
    // Claude's web search (a few seconds; about 1 cent unless the same search was made in the last 30 min)
    function searchWeb(v, q) {
        var js = function(fn, data) {
            if (w.isSearch(v.url) && w.searchQuery(v.url) === q)
                v.runJavaScript("window." + fn + " && window." + fn + "(" + JSON.stringify(data) + ", " + JSON.stringify(q) + ")")
        }
        js("nexusWebState", "loading")
        Session.request("GET", "/search/web?q=" + encodeURIComponent(q), null, function(st, j) {
            js("nexusWeb", st === 200 && j ? j : { error: st === 403 ? "off" : st === 0 ? "offline" : "error" })
        })
    }
    // What the results page asks NEXUS to do. Only that page's own messages count (a website cannot log from there).
    function searchAction(v, message) {
        var m = /^nexus-search:(.*)$/.exec(String(message))
        if (!m || !isSearch(v.url)) return
        var a
        try { a = JSON.parse(m[1]) } catch (e) { return }
        if (!a || typeof a.act !== "string") return
        if (a.act === "launch" && typeof a.app === "string") Session.launch(a.app)
        else if (a.act === "settings" && typeof a.page === "string") Session.openSettings(a.page)
        else if (a.act === "file" && typeof a.path === "string") Session.request("POST", "/launch", { app: "files", path: a.dir ? a.path : a.path.replace(/\/[^\/]*$/, "") }, null)
        else if (a.act === "web") searchWeb(v, searchQuery(v.url))
        else if (a.act === "answer") searchAnswer(v, searchQuery(v.url))
        else if (a.act === "pref" && a.key === "searchWeb" && ["auto", "manual", "off"].indexOf(a.value) >= 0) { Session.setPref("searchWeb", a.value); feedSearch(v, a.value) }
        else if (a.act === "pref" && a.key === "searchMemory" && typeof a.value === "boolean") Session.setPref("searchMemory", a.value)
        else if (a.act === "forget" && typeof a.url === "string") Session.request("POST", "/search/forget", { url: a.url }, null)
        else if (a.act === "clear") Session.request("POST", "/search/clear", {}, null)
    }
    // NEXUS Search remembers the pages you visit (only on this computer), unless they ask for a password or say
    // "noindex" (mail, banks, private apps usually do). Read in an isolated world (1 = ApplicationWorld): the page's
    // own scripts cannot see or change this.
    readonly property string pageReader: "(function(){try{" +
        "if(document.querySelector('input[type=password]'))return null;" +
        "var r=document.querySelector('meta[name=robots]');if(r&&/noindex/i.test(r.content||''))return null;" +
        "var d=document.querySelector('meta[name=description],meta[property=\"og:description\"]');" +
        "var m=document.querySelector('#mw-content-text,article,main,[role=main]')||document.body;" +
        "var c=m.cloneNode(true);c.querySelectorAll('script,style,noscript,template,nav,header,footer,aside,form,button,select,[role=navigation],[aria-hidden=true],.mw-editsection,.navbox,.reflist,.infobox,sup').forEach(function(e){e.remove()});" +
        "return{url:location.href,title:document.title,description:d?String(d.content||''):'',text:String(c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,4000)}" +
        "}catch(e){return null}})()"
    function remember(v) {
        if (Session.prefs.searchMemory === false || !/^https?:\/\//i.test(String(v.url))) return
        v.runJavaScript(pageReader, 1, function(r) { if (r && r.url) Session.request("POST", "/search/visit", r, null) })
    }
    Timer { interval: 3000; repeat: true; running: !!w.current && w.isNewTab(w.current.url) && w.active; onTriggered: w.feedServers() }
    function zoom(f) { if (current) current.zoomFactor = f === 1 ? 1 : Math.max(0.3, Math.min(3, Math.round(current.zoomFactor * f * 10) / 10)) }

    WebEngineProfile {
        id: profile
        storageName: "nexus"
        persistentStoragePath: w.dataDir + "/nexus/navegador"
        cachePath: w.cacheDir + "/nexus/navegador"
        httpCacheType: WebEngineProfile.DiskHttpCache
        persistentCookiesPolicy: WebEngineProfile.AllowPersistentCookies
        httpAcceptLanguage: "es-ES,es;q=0.9,en;q=0.8"
        downloadPath: w.home + "/Descargas"
        onDownloadRequested: function(d) { d.accept(); w.toast("Descargando " + d.downloadFileName + "…") }
        onDownloadFinished: function(d) {
            w.toast(d.state === WebEngineDownloadRequest.DownloadCompleted ? "Guardado en Descargas: " + d.downloadFileName
                                                                          : "La descarga de " + d.downloadFileName + " no se ha completado")
        }
    }

    Component {
        id: tabComp
        WebEngineView {
            id: view
            anchors.fill: parent
            visible: w.current === view
            settings.fullScreenSupportEnabled: true
            settings.focusOnNavigationEnabled: true
            settings.dnsPrefetchEnabled: true
            onNewWindowRequested: function(req) { var t = w.addTab(""); req.openIn(t) }
            onFullScreenRequested: function(req) { req.accept(); if (req.toggleOn) w.showFullScreen(); else w.showNormal() }
            onLinkHovered: function(u) { if (w.current === view) w.hovered = String(u) }
            onRenderProcessTerminated: function(status, code) { if (status !== WebEngineView.NormalTerminationStatus) w.toast("La página se ha cerrado inesperadamente. Recárgala con Ctrl+R.") }
            onLoadingChanged: function(r) {
                if (r.status !== WebEngineLoadingInfo.LoadSucceededStatus) return
                if (w.current === view && w.isNewTab(view.url)) w.feedServers()
                else if (w.isSearch(view.url)) w.feedSearch(view, "")
                else if (/^https?:\/\//i.test(String(view.url))) memo.restart()
            }
            onJavaScriptConsoleMessage: function(level, message, line, source) { if (w.isSearch(source)) w.searchAction(view, message) }
            Timer { id: memo; interval: 1500; onTriggered: w.remember(view) }   // once the page has settled
            onFindTextFinished: function(r) { findCount.text = r.numberOfMatches ? (r.activeMatch + "/" + r.numberOfMatches) : (findField.text ? "0" : "") }
        }
    }

    // ------------------------------------------------------------------ small drawing helpers
    component Glyph: Shape {
        id: g
        property string d
        property color c: Theme.text
        property real stroke: 1.9
        width: 24; height: 24
        ShapePath {
            strokeColor: g.c; strokeWidth: g.stroke; fillColor: "transparent"
            capStyle: ShapePath.RoundCap; joinStyle: ShapePath.RoundJoin
            PathSvg { path: g.d }
        }
    }
    component IconButton: Rectangle {
        id: b
        property string d
        property bool active: true
        property bool on: false
        property string tip: ""
        signal clicked()
        width: 34; height: 34; radius: 10
        color: on ? Theme.alpha(Theme.accent, 0.22) : (ma.containsMouse && active ? Theme.hover : "transparent")
        Glyph { anchors.centerIn: parent; d: b.d; scale: 0.78; c: b.on ? Theme.accent : (b.active ? Theme.text : Theme.faint) }
        MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; onClicked: if (b.active) b.clicked() }
        ToolTip.visible: tip !== "" && ma.containsMouse; ToolTip.text: tip; ToolTip.delay: 600
    }
    readonly property var icon: ({
        back: "M15 18l-6-6 6-6", forward: "M9 18l6-6-6-6", close: "M18 6L6 18M6 6l12 12", plus: "M5 12h14M12 5v14",
        reload: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6", code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
        lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11", search: "M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM20.5 20.5l-4.2-4.2",
        warn: "M12 3l10 18H2zM12 10v5M12 18v.5", send: "M5 12h14M13 6l6 6-6 6", home: "M4 11l8-7 8 7M6 9.5V20h12V9.5",
        globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
        clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.2 2", grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
        gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2.5v3M12 18.5v3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M2.5 12h3M18.5 12h3M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"
    })

    // ------------------------------------------------------------------ tab strip
    Rectangle {
        id: strip
        width: parent.width; height: 42
        color: Theme.dark ? "#080b13" : "#e2e6f1"
        Row {
            x: 10; y: 6; spacing: 4; height: 36
            Repeater {
                model: w.tabs
                delegate: Rectangle {
                    id: tab
                    required property var modelData
                    readonly property bool sel: w.current === modelData
                    width: Math.max(120, Math.min(230, (strip.width - 80) / Math.max(1, w.tabs.length) - 4)); height: 36
                    radius: 11
                    color: sel ? Theme.bg : (tma.containsMouse ? Theme.hover : "transparent")
                    border.color: sel ? Theme.border : "transparent"
                    Image {
                        id: fav
                        x: 12; anchors.verticalCenter: parent.verticalCenter
                        width: 16; height: 16; sourceSize: Qt.size(32, 32)
                        source: tab.modelData.icon
                        visible: status === Image.Ready && !tab.modelData.loading
                    }
                    Rectangle {   // loading dot
                        x: 15; anchors.verticalCenter: parent.verticalCenter
                        width: 10; height: 10; radius: 5; color: Theme.accent
                        visible: tab.modelData.loading
                        SequentialAnimation on opacity { running: tab.modelData.loading; loops: Animation.Infinite
                            NumberAnimation { to: 0.25; duration: 500 } NumberAnimation { to: 1; duration: 500 } }
                    }
                    Text {
                        x: 36; width: parent.width - 36 - 32; anchors.verticalCenter: parent.verticalCenter
                        text: tab.modelData.title || (w.isNewTab(tab.modelData.url) ? "Nueva pestaña" : w.shownUrl(tab.modelData.url))
                        elide: Text.ElideRight
                        color: tab.sel ? Theme.text : Theme.dim
                        font.family: Theme.font; font.pixelSize: 13
                    }
                    MouseArea {
                        id: tma; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                        onClicked: function(m) { if (m.button === Qt.MiddleButton) w.closeTab(tab.modelData); else w.current = tab.modelData }
                    }
                    IconButton {
                        anchors.right: parent.right; anchors.rightMargin: 4; anchors.verticalCenter: parent.verticalCenter
                        width: 26; height: 26; radius: 8
                        d: w.icon.close; tip: "Cerrar pestaña (Ctrl+W)"
                        visible: tab.sel || tma.containsMouse
                        onClicked: w.closeTab(tab.modelData)
                    }
                }
            }
            IconButton { d: w.icon.plus; tip: "Pestaña nueva (Ctrl+T)"; anchors.verticalCenter: parent.verticalCenter; onClicked: w.addTab("") }
        }
    }

    // ------------------------------------------------------------------ toolbar
    Rectangle {
        id: bar
        z: 3   // its suggestions drop over the page
        y: strip.height; width: parent.width; height: 52
        color: Theme.bg
        Row {
            id: nav
            x: 10; anchors.verticalCenter: parent.verticalCenter; spacing: 2
            IconButton { d: w.icon.back; active: !!w.current && w.current.canGoBack; tip: "Atrás (Alt+←)"; onClicked: w.current.goBack() }
            IconButton { d: w.icon.forward; active: !!w.current && w.current.canGoForward; tip: "Adelante (Alt+→)"; onClicked: w.current.goForward() }
            IconButton {
                d: w.current && w.current.loading ? w.icon.close : w.icon.reload
                tip: w.current && w.current.loading ? "Detener" : "Recargar (Ctrl+R)"
                onClicked: if (w.current) { if (w.current.loading) w.current.stop(); else w.current.reload() }
            }
        }
        Rectangle {
            id: field
            anchors.left: nav.right; anchors.leftMargin: 8; anchors.right: tools.left; anchors.rightMargin: 8
            anchors.verticalCenter: parent.verticalCenter
            height: 38; radius: 12
            color: Theme.dark ? Qt.rgba(1, 1, 1, 0.055) : "#ffffff"
            border.color: addr.activeFocus ? Theme.accent : Theme.border
            border.width: addr.activeFocus ? 1.5 : 1
            Glyph {
                id: badge
                x: 12; anchors.verticalCenter: parent.verticalCenter; scale: 0.62
                readonly property string u: w.current ? String(w.current.url) : ""
                d: w.insecure(u) ? w.icon.warn : (/^https:/.test(u) ? w.icon.lock : w.icon.search)
                c: w.insecure(u) ? Theme.warn : Theme.dim
            }
            Text {
                id: notSecure
                visible: w.insecure(badge.u) && !addr.activeFocus
                anchors.left: badge.right; anchors.verticalCenter: parent.verticalCenter
                text: "No seguro"; color: Theme.warn; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.Medium
            }
            TextField {
                id: addr
                anchors.left: notSecure.visible ? notSecure.right : badge.right; anchors.leftMargin: notSecure.visible ? 10 : 2
                anchors.right: zoomTag.left; anchors.rightMargin: 6
                anchors.verticalCenter: parent.verticalCenter
                height: parent.height - 4
                background: null
                color: Theme.text; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
                placeholderText: "Busca con NEXUS Search o escribe una dirección  ·  gh, so, mdn, npm, pypi  ·  localhost:3000"
                placeholderTextColor: Theme.faint
                font.family: Theme.font; font.pixelSize: 14
                selectByMouse: true
                onActiveFocusChanged: { w.typed = ""; w.typedLen = 0; w.sugg = []; if (activeFocus) { text = w.shownUrl(w.current ? w.current.url : ""); selectAll() } }
                Binding on text { when: !addr.activeFocus; value: w.shownUrl(w.current ? w.current.url : "") }
                onTextEdited: w.typing(text)
                Keys.onReturnPressed: w.enterAddress()
                Keys.onEnterPressed: w.enterAddress()
                Keys.onDownPressed: if (w.suggOpen) w.suggAt = Math.min(w.sugg.length - 1, w.suggAt + 1)
                Keys.onUpPressed: if (w.suggOpen) w.suggAt = Math.max(0, w.suggAt - 1)
                Keys.onEscapePressed: {
                    if (w.suggOpen) { w.sugg = []; text = w.typed; return }
                    text = w.shownUrl(w.current ? w.current.url : ""); if (w.current) w.current.forceActiveFocus()
                }
            }
            Rectangle {
                id: zoomTag
                anchors.right: parent.right; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter
                visible: !!w.current && Math.abs(w.current.zoomFactor - 1) > 0.01
                width: visible ? zt.implicitWidth + 16 : 0; height: 24; radius: 8
                color: Theme.hover
                Text { id: zt; anchors.centerIn: parent; text: w.current ? Math.round(w.current.zoomFactor * 100) + " %" : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                MouseArea { anchors.fill: parent; onClicked: w.zoom(1) }
            }
            Rectangle {   // suggestions while typing, as in Safari: the site to complete, NEXUS Search, suggestions, history, apps
                id: suggBox
                visible: w.suggOpen
                y: parent.height + 6; width: parent.width
                height: suggCol.height + 12; radius: 14
                color: Theme.dark ? "#121624" : "#ffffff"
                border.color: Theme.border; border.width: 1
                Rectangle { anchors.fill: parent; anchors.topMargin: 6; anchors.margins: -1; z: -1; radius: 16; color: Qt.rgba(0, 0, 0, Theme.dark ? 0.35 : 0.10) }
                Column {
                    id: suggCol
                    x: 6; y: 6; width: parent.width - 12
                    Repeater {
                        model: w.sugg
                        delegate: Rectangle {
                            id: srow
                            required property var modelData
                            required property int index
                            readonly property bool sel: index === w.suggAt
                            width: suggCol.width; height: 40; radius: 10
                            color: sel ? Theme.alpha(Theme.accent, 0.22) : (rma.containsMouse ? Theme.hover : "transparent")
                            Rectangle {   // a thin line between NEXUS Search's own rows and the rest
                                visible: srow.index > 0 && w.sugg[srow.index - 1].kind !== srow.modelData.kind && (srow.modelData.kind === "phrase" || srow.modelData.kind === "page" || srow.modelData.kind === "app")
                                width: parent.width - 20; x: 10; height: 1; color: Theme.border
                            }
                            Glyph {
                                x: 8; anchors.verticalCenter: parent.verticalCenter; scale: 0.7
                                d: w.icon[{ top: "globe", go: w.looksLikeAddress(srow.modelData.title) ? "globe" : "search", phrase: "search", page: "clock", app: "grid", setting: "gear" }[srow.modelData.kind] || "search"]
                                c: srow.sel ? Theme.accent : Theme.dim
                            }
                            Text {
                                id: st1
                                x: 42; anchors.verticalCenter: parent.verticalCenter
                                width: Math.min(implicitWidth, parent.width * 0.62)
                                text: srow.modelData.title; elide: Text.ElideRight
                                color: Theme.text; font.family: Theme.font; font.pixelSize: 14
                                font.weight: srow.modelData.kind === "top" ? Font.DemiBold : Font.Normal
                            }
                            Text {
                                anchors.left: st1.right; anchors.leftMargin: 10; anchors.right: parent.right; anchors.rightMargin: 12
                                anchors.verticalCenter: parent.verticalCenter
                                text: srow.modelData.sub ? "—  " + srow.modelData.sub : ""; elide: Text.ElideRight
                                color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
                            }
                            MouseArea { id: rma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.pick(srow.modelData) }
                        }
                    }
                }
            }
            Rectangle {   // load progress along the bottom of the field
                anchors.bottom: parent.bottom; anchors.left: parent.left; anchors.leftMargin: 10
                height: 2; radius: 1
                width: w.current && w.current.loading ? (parent.width - 20) * w.current.loadProgress / 100 : 0
                visible: width > 0
                gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: Theme.accent } GradientStop { position: 1; color: Theme.accent2 } }
                Behavior on width { NumberAnimation { duration: 180 } }
            }
        }
        Row {
            id: tools
            anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter
            spacing: 4
            IconButton { d: w.icon.code; on: w.devOpen; tip: "Herramientas de desarrollo (F12)"; onClicked: w.devOpen = !w.devOpen }
            Rectangle {   // "Pregunta a NEXUS" about this page
                width: aiRow.implicitWidth + 22; height: 34; radius: 11
                color: w.aiOpen ? Theme.accent : (aiMa.containsMouse ? Theme.alpha(Theme.accent, 0.30) : Theme.alpha(Theme.accent, 0.18))
                border.color: Theme.alpha(Theme.accent, 0.55)
                Row {
                    id: aiRow; anchors.centerIn: parent; spacing: 8
                    Image { source: Qt.resolvedUrl("../icons/nexus.svg"); width: 18; height: 18; sourceSize: Qt.size(36, 36); anchors.verticalCenter: parent.verticalCenter }
                    Text { text: "NEXUS AI"; color: w.aiOpen ? "#ffffff" : Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.Medium; anchors.verticalCenter: parent.verticalCenter }
                }
                MouseArea { id: aiMa; anchors.fill: parent; hoverEnabled: true; onClicked: { w.aiOpen = !w.aiOpen; if (w.aiOpen) ask.forceActiveFocus() } }
                ToolTip.visible: aiMa.containsMouse; ToolTip.text: "Pregunta a NEXUS AI sobre esta página (Ctrl+J)"; ToolTip.delay: 600
            }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.border }
    }

    // ------------------------------------------------------------------ page + developer tools + NEXUS AI panel
    Item {
        id: body
        y: bar.y + bar.height; width: parent.width - (w.aiOpen ? panel.width : 0); height: parent.height - y
        Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        Item {
            id: pages
            width: parent.width; height: parent.height - (w.devOpen ? devPane.height : 0)
        }
        Rectangle {
            id: devPane
            visible: w.devOpen
            anchors.bottom: parent.bottom; width: parent.width; height: Math.round(parent.height * 0.42)
            color: Theme.card
            Rectangle { width: parent.width; height: 1; color: Theme.border }
            WebEngineView {
                id: devtools
                anchors.fill: parent; anchors.topMargin: 1
                inspectedView: w.devOpen ? w.current : null
            }
        }
        // link under the mouse, bottom left
        Rectangle {
            visible: w.hovered !== ""
            anchors.left: parent.left; anchors.bottom: pages.bottom; anchors.margins: 6
            width: Math.min(hov.implicitWidth + 16, parent.width * 0.6); height: 24; radius: 8
            color: Theme.card; border.color: Theme.border
            Text { id: hov; anchors.verticalCenter: parent.verticalCenter; x: 8; width: parent.width - 16; elide: Text.ElideMiddle
                   text: w.hovered; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
        }
        // find in page (Ctrl+F)
        Rectangle {
            id: findBar
            visible: w.findOpen
            anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
            width: 330; height: 44; radius: 12
            color: Theme.card; border.color: Theme.border
            Glyph { x: 10; anchors.verticalCenter: parent.verticalCenter; d: w.icon.search; scale: 0.62; c: Theme.dim }
            TextField {
                id: findField
                x: 34; width: parent.width - 34 - 110; anchors.verticalCenter: parent.verticalCenter
                background: null; color: Theme.text; placeholderText: "Buscar en la página"; placeholderTextColor: Theme.faint
                font.family: Theme.font; font.pixelSize: 14; selectByMouse: true
                onTextChanged: if (w.current) w.current.findText(text)
                Keys.onReturnPressed: function(e) { if (w.current) w.current.findText(text, (e.modifiers & Qt.ShiftModifier) ? WebEngineView.FindBackward : 0) }
                Keys.onEscapePressed: w.closeFind()
            }
            Text { id: findCount; anchors.right: findClose.left; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
            IconButton { id: findClose; anchors.right: parent.right; anchors.rightMargin: 5; anchors.verticalCenter: parent.verticalCenter; d: w.icon.close; width: 30; height: 30; onClicked: w.closeFind() }
        }
        // downloads and notices
        Rectangle {
            visible: opacity > 0
            opacity: toastTimer.running ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
            anchors.horizontalCenter: pages.horizontalCenter; anchors.bottom: pages.bottom; anchors.bottomMargin: 18
            width: Math.min(tt.implicitWidth + 32, parent.width - 40); height: 40; radius: 12
            color: Theme.card; border.color: Theme.border
            Text { id: tt; anchors.centerIn: parent; width: parent.width - 32; horizontalAlignment: Text.AlignHCenter; elide: Text.ElideMiddle
                   text: w.toastText; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
        }
    }
    function closeFind() { findOpen = false; if (current) { current.findText(""); current.forceActiveFocus() } }
    Timer { id: toastTimer; interval: 3500 }

    Rectangle {
        id: panel
        x: parent.width - (w.aiOpen ? width : 0); y: body.y; width: 380; height: body.height
        visible: x < parent.width
        Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        color: Theme.dark ? "#0f1220" : "#f6f7fc"
        Rectangle { width: 1; height: parent.height; color: Theme.border }

        property bool busy: false
        property var history: []
        ListModel { id: chat }

        function pageData(cb) {
            var v = w.current
            if (!v || w.isNewTab(v.url)) { cb(null); return }
            v.runJavaScript("JSON.stringify({ sel: String(window.getSelection() || '').slice(0, 8000), " +
                            "text: (document.body ? document.body.innerText : '').slice(0, 24000) })", function(r) {
                var d = null
                try { d = JSON.parse(r) } catch (e) { d = { sel: "", text: "" } }
                cb({ title: String(v.title || ""), url: String(v.url), text: d.text, selection: d.sel })
            })
        }
        function send(q) {
            q = String(q).trim(); if (!q || busy) return
            chat.append({ who: "user", text: q }); busy = true; ask.text = ""
            pageData(function(page) {
                var req = { text: q, history: panel.history.slice(-8) }
                if (page) req.page = page
                Session.request("POST", "/ai", req, function(st, j) {
                    panel.busy = false
                    var t = st === 200 && j ? String(j.text || "") : (st === 503 ? "El motor de NEXUS no responde ahora mismo. Vuelve a intentarlo en unos segundos." : "No he podido responder (error " + st + ").")
                    chat.append({ who: "ai", text: t })
                    if (st === 200) panel.history = panel.history.concat([{ role: "user", text: q }, { role: "assistant", text: t }])
                    log.positionViewAtEnd()
                })
            })
            log.positionViewAtEnd()
        }

        Row {
            x: 18; y: 16; spacing: 10
            Image { source: Qt.resolvedUrl("../icons/nexus-tile.svg"); width: 30; height: 30; sourceSize: Qt.size(60, 60) }
            Column {
                anchors.verticalCenter: parent.verticalCenter
                Text { text: "NEXUS AI"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                Text { text: w.current && !w.isNewTab(w.current.url) ? "Sobre: " + (w.current.title || w.shownUrl(w.current.url)) : "Pregúntame lo que quieras"
                       width: 300; elide: Text.ElideRight; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
            }
        }
        IconButton { anchors.right: parent.right; anchors.rightMargin: 10; y: 14; d: w.icon.close; onClicked: w.aiOpen = false }

        ListView {
            id: log
            x: 14; y: 66; width: parent.width - 28; height: parent.height - y - inputBox.height - 26
            clip: true; spacing: 10
            model: chat
            header: Flow {
                width: log.width; spacing: 8; bottomPadding: 12
                visible: chat.count === 0
                height: visible ? implicitHeight : 0
                Repeater {
                    model: ["Resume esta página", "Explica lo que he seleccionado", "Traduce lo seleccionado al español", "¿Hay errores en este código?"]
                    delegate: Rectangle {
                        required property string modelData
                        width: chipText.implicitWidth + 24; height: 32; radius: 10
                        color: chipMa.containsMouse ? Theme.alpha(Theme.accent, 0.24) : Theme.alpha(Theme.accent, 0.12)
                        border.color: Theme.alpha(Theme.accent, 0.35)
                        Text { id: chipText; anchors.centerIn: parent; text: parent.modelData; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                        MouseArea { id: chipMa; anchors.fill: parent; hoverEnabled: true; onClicked: panel.send(parent.modelData) }
                    }
                }
            }
            delegate: Item {
                id: row
                required property string who
                required property string text
                width: log.width; height: bubble.height + (who === "ai" ? 18 : 0)
                readonly property real maxW: log.width * (who === "user" ? 0.86 : 1) - 24
                Text { visible: row.who === "ai"; text: "NEXUS AI"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.Medium }
                TextMetrics { id: tm; font: msg.font; text: row.text }
                Rectangle {
                    id: bubble
                    y: row.who === "ai" ? 18 : 0
                    anchors.right: row.who === "user" ? parent.right : undefined
                    width: msg.width + 24; height: msg.implicitHeight + 18
                    radius: 14
                    color: row.who === "user" ? Theme.accent : Theme.card2
                    TextEdit {
                        id: msg
                        x: 12; y: 9; width: Math.min(row.maxW, tm.advanceWidth + 4)
                        text: row.text; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap
                        color: row.who === "user" ? "#ffffff" : Theme.text; selectionColor: Theme.alpha(Theme.accent2, 0.45)
                        font.family: Theme.font; font.pixelSize: 14
                    }
                }
            }
            footer: Item {
                width: log.width; height: panel.busy ? 34 : 0
                Row {
                    visible: panel.busy; spacing: 6; y: 12
                    Repeater { model: 3; delegate: Rectangle { required property int index; width: 7; height: 7; radius: 3.5; color: Theme.accent
                        SequentialAnimation on opacity { loops: Animation.Infinite; running: panel.busy
                            PauseAnimation { duration: index * 160 } NumberAnimation { to: 0.2; duration: 380 } NumberAnimation { to: 1; duration: 380 } } } }
                }
            }
        }
        Rectangle {
            id: inputBox
            x: 14; width: parent.width - 28; height: 46; radius: 14
            anchors.bottom: parent.bottom; anchors.bottomMargin: 14
            color: Theme.dark ? Qt.rgba(1, 1, 1, 0.06) : "#ffffff"
            border.color: ask.activeFocus ? Theme.accent : Theme.border
            TextField {
                id: ask
                x: 12; width: parent.width - 12 - 44; anchors.verticalCenter: parent.verticalCenter
                background: null; color: Theme.text; placeholderText: "Pregunta sobre esta página…"; placeholderTextColor: Theme.faint
                font.family: Theme.font; font.pixelSize: 14; selectByMouse: true
                onAccepted: panel.send(text)
                Keys.onEscapePressed: { w.aiOpen = false; if (w.current) w.current.forceActiveFocus() }
            }
            IconButton { anchors.right: parent.right; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter; d: w.icon.send; active: ask.text.trim() !== "" && !panel.busy; onClicked: panel.send(ask.text) }
        }
    }

    // ------------------------------------------------------------------ keyboard (Ctrl, and ⌘/Super on Mac keyboards)
    Shortcut { sequences: ["Ctrl+T", "Meta+T"]; onActivated: w.addTab("") }
    Shortcut { sequences: ["Ctrl+W", "Meta+W"]; onActivated: w.closeTab(w.current) }
    Shortcut { sequences: ["Ctrl+L", "F6", "Alt+D"]; onActivated: { addr.forceActiveFocus(); addr.selectAll() } }
    Shortcut { sequences: ["Ctrl+R", "F5", "Meta+R"]; onActivated: if (w.current) w.current.reload() }
    Shortcut { sequences: ["Ctrl+Shift+R", "Shift+F5"]; onActivated: if (w.current) w.current.triggerWebAction(WebEngineView.ReloadAndBypassCache) }
    Shortcut { sequences: ["Alt+Left", "Meta+["]; onActivated: if (w.current) w.current.goBack() }
    Shortcut { sequences: ["Alt+Right", "Meta+]"]; onActivated: if (w.current) w.current.goForward() }
    Shortcut { sequences: ["Ctrl+Tab", "Ctrl+PgDown"]; onActivated: w.cycle(1) }
    Shortcut { sequences: ["Ctrl+Shift+Tab", "Ctrl+PgUp"]; onActivated: w.cycle(-1) }
    Shortcut { sequences: ["Ctrl+F", "Meta+F"]; onActivated: { w.findOpen = true; findField.forceActiveFocus(); findField.selectAll() } }
    Shortcut { sequences: ["F12", "Ctrl+Shift+I", "Meta+Alt+I"]; onActivated: w.devOpen = !w.devOpen }
    Shortcut { sequences: ["Ctrl+J", "Meta+J"]; onActivated: { w.aiOpen = !w.aiOpen; if (w.aiOpen) ask.forceActiveFocus() } }
    Shortcut { sequences: ["Ctrl++", "Ctrl+=", "Meta++", "Meta+="]; onActivated: w.zoom(1.1) }
    Shortcut { sequences: ["Ctrl+-", "Meta+-"]; onActivated: w.zoom(1 / 1.1) }
    Shortcut { sequences: ["Ctrl+0", "Meta+0"]; onActivated: w.zoom(1) }
    Shortcut { sequences: ["Ctrl+U"]; onActivated: if (w.current && !w.isNewTab(w.current.url)) w.addTab("view-source:" + String(w.current.url)) }
    Shortcut { sequence: "Esc"; enabled: w.visibility === Window.FullScreen; onActivated: { if (w.current) w.current.triggerWebAction(WebEngineView.ExitFullScreen); w.showNormal() } }

    Component.onCompleted: {
        var open = ""
        var a = Qt.application.arguments
        for (var i = 0; i < a.length; i++) if (String(a[i]).indexOf("--open=") === 0) open = String(a[i]).slice(7)
        addTab(open)
    }
}
