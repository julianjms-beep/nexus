import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtWebEngine
import QtCore
import "../shell"

// One web app from NEXUS Store in a window of its own: `nexus-app WebApp <address> <name> <id>` (nexus-sessiond
// starts it, only for an installed app). Each app has its own browser profile, so it stays signed in and shares no
// cookies with the browser or with the other apps. Only https pages; a link to another site opens in the Navegador.
Window {
    id: w
    visible: true
    width: 1180; height: 780
    minimumWidth: 520; minimumHeight: 420
    color: Theme.bg

    property string appUrl: ""
    property string appName: "App"
    property string appId: "app"
    readonly property string dataDir: String(StandardPaths.writableLocation(StandardPaths.GenericDataLocation)).replace("file://", "")
    readonly property string cacheDir: String(StandardPaths.writableLocation(StandardPaths.GenericCacheLocation)).replace("file://", "")
    readonly property string home: String(StandardPaths.writableLocation(StandardPaths.HomeLocation)).replace("file://", "")
    title: appName
    property var pending: null          // a permission the app asked for (camera, microphone…), waiting for the person
    property string pendingWhat: ""
    property string note: ""
    Timer { id: noteOff; interval: 4500; onTriggered: w.note = "" }
    function say(t) { note = t; noteOff.restart() }
    function hostOf(u) { var m = /^https:\/\/([^\/:?#]+)/i.exec(String(u)); return m ? m[1].toLowerCase() : "" }
    // the app's own site: its host or any host under the same registered name (web.whatsapp.com ↔ whatsapp.com)
    function site(h) { var p = String(h).split("."); return p.slice(-2).join(".") }

    Component.onCompleted: {
        var a = Qt.application.arguments
        for (var i = 0; i < a.length; i++) {
            var v = String(a[i])
            if (v.indexOf("--url=") === 0 && /^https:\/\/[^\s]+$/i.test(v.slice(6))) appUrl = v.slice(6)
            else if (v.indexOf("--name=") === 0) appName = v.slice(7).slice(0, 40) || "App"
            else if (v.indexOf("--id=") === 0) appId = v.slice(5).replace(/[^a-z0-9-]/g, "") || "app"
        }
        // The engine is Chromium; its default name also carries "QtWebEngine/x.y", which some services (WhatsApp) read
        // as "an old browser". Say what the engine is, as other Qt browsers do: the same string without that word.
        profile.httpUserAgent = String(profile.httpUserAgent).replace(/\s*QtWebEngine\/\S+/, "")
        if (appUrl) view.url = appUrl
    }

    WebEngineProfile {
        id: profile
        storageName: "webapp-" + w.appId
        persistentStoragePath: w.dataDir + "/nexus/webapps/" + w.appId
        cachePath: w.cacheDir + "/nexus/webapps/" + w.appId
        httpCacheType: WebEngineProfile.DiskHttpCache
        persistentCookiesPolicy: WebEngineProfile.AllowPersistentCookies
        httpAcceptLanguage: "es-ES,es;q=0.9,en;q=0.8"
        downloadPath: w.home + "/Descargas"
        onDownloadRequested: function(d) { d.accept(); w.say("Descargando " + d.downloadFileName + "…") }
        onDownloadFinished: function(d) { w.say(d.state === WebEngineDownloadRequest.DownloadCompleted ? "Guardado en Descargas: " + d.downloadFileName : "La descarga no se ha completado") }
    }

    // ---- a slim bar: back, reload, where you are (with the padlock), and the way home
    Rectangle {
        id: bar
        width: parent.width; height: 40
        color: Theme.card
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.border }
        Row {
            x: 10; anchors.verticalCenter: parent.verticalCenter; spacing: 4
            Repeater {
                model: [["back", "Atrás"], ["forward", "Adelante"], ["restore", "Recargar"]]
                Rectangle {
                    required property var modelData
                    required property int index
                    readonly property bool can: index === 0 ? view.canGoBack : index === 1 ? view.canGoForward : true
                    width: 30; height: 30; radius: 9
                    color: ba.containsMouse && can ? Theme.hover : "transparent"
                    opacity: can ? 1 : 0.35
                    LineIcon { anchors.centerIn: parent; name: modelData[0]; color: Theme.text; size: 17 }
                    MouseArea { id: ba; anchors.fill: parent; hoverEnabled: true; onClicked: { if (index === 0) view.goBack(); else if (index === 1) view.goForward(); else view.reload() } }
                }
            }
        }
        Row {
            anchors.centerIn: parent; spacing: 7
            LineIcon { name: "lock"; color: Theme.good; size: 14; anchors.verticalCenter: parent.verticalCenter; visible: /^https:/i.test(String(view.url)) }
            Text { text: w.hostOf(view.url) || w.appName; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; anchors.verticalCenter: parent.verticalCenter }
        }
        Rectangle {
            anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter
            width: homeText.implicitWidth + 22; height: 28; radius: 9
            color: ha.containsMouse ? Theme.hover : "transparent"
            Text { id: homeText; anchors.centerIn: parent; text: "Inicio de " + w.appName; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
            MouseArea { id: ha; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: view.url = w.appUrl }
        }
        Rectangle {   // loading line
            anchors.bottom: parent.bottom; height: 2; color: Theme.accent
            width: parent.width * view.loadProgress / 100
            visible: view.loading
        }
    }

    WebEngineView {
        id: view
        anchors.top: bar.bottom; anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
        profile: profile
        settings.fullScreenSupportEnabled: true
        settings.focusOnNavigationEnabled: true
        settings.javascriptCanAccessClipboard: true
        backgroundColor: Theme.bg
        // never a plain-http page inside an app, and never a local file
        onNavigationRequested: function(req) {
            var u = String(req.url)
            if (/^(https|about|blob|data):/i.test(u)) return
            req.reject()
            if (/^http:/i.test(u)) w.say("Bloqueada una página sin cifrar (http://)")
        }
        // a link that opens a new window: the app's own site stays here, anything else goes to the Navegador
        onNewWindowRequested: function(req) {
            var u = String(req.requestedUrl)
            if (!/^https:/i.test(u)) return
            if (w.site(w.hostOf(u)) === w.site(w.hostOf(w.appUrl)) || w.site(w.hostOf(u)) === w.site(w.hostOf(view.url))) view.url = req.requestedUrl
            else { Session.request("POST", "/store/link", { url: u }, null); w.say("Abierto en el Navegador") }
        }
        onFullScreenRequested: function(req) { req.accept(); if (req.toggleOn) w.showFullScreen(); else w.showNormal() }
        // camera, microphone, notifications…: only for the app's own site, and only when it asks
        onPermissionRequested: function(permission) {
            if (w.site(w.hostOf(permission.origin)) !== w.site(w.hostOf(w.appUrl))) { permission.deny(); return }
            var t = permission.permissionType, P = WebEnginePermission.PermissionType
            var what = t === P.MediaAudioCapture ? "el micrófono" : t === P.MediaVideoCapture ? "la cámara" : t === P.MediaAudioVideoCapture ? "la cámara y el micrófono"
                     : t === P.Geolocation ? "tu ubicación" : t === P.DesktopVideoCapture || t === P.DesktopAudioVideoCapture ? "tu pantalla" : ""
            if (what === "") { permission.grant(); return }      // notifications, clipboard…: the app's own site may
            w.pending = permission; w.pendingWhat = what          // the delicate ones wait for the person's click
        }
        onRenderProcessTerminated: function(status, code) { if (status !== WebEngineView.NormalTerminationStatus) w.say("La app se ha cerrado inesperadamente. Recárgala.") }
    }
    Shortcut { sequence: "Ctrl+R"; onActivated: view.reload() }
    Shortcut { sequence: "F5"; onActivated: view.reload() }
    Shortcut { sequence: "Alt+Left"; onActivated: view.goBack() }
    Shortcut { sequence: "Alt+Right"; onActivated: view.goForward() }
    Shortcut { sequence: "Ctrl+W"; onActivated: w.close() }

    Rectangle {
        visible: !w.appUrl
        anchors.fill: parent; color: Theme.bg
        Text { anchors.centerIn: parent; text: "Esta app se abre desde NEXUS Store."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 15 }
    }
    Rectangle {   // "may this app use the microphone?"
        visible: w.pending !== null
        anchors.horizontalCenter: parent.horizontalCenter; y: bar.height + 12
        width: Math.min(parent.width - 40, askRow.width + 36); height: 52; radius: 16
        color: Theme.card; border.color: Theme.accent
        Row {
            id: askRow
            anchors.centerIn: parent; spacing: 14
            Text { text: w.appName + " quiere usar " + w.pendingWhat; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
            Repeater {
                model: [["No", false], ["Permitir", true]]
                Rectangle {
                    required property var modelData
                    width: pt.implicitWidth + 24; height: 30; radius: 15
                    color: modelData[1] ? Theme.accent : Theme.card2
                    Text { id: pt; anchors.centerIn: parent; text: modelData[0]; color: modelData[1] ? "#ffffff" : Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { if (w.pending) { if (modelData[1]) w.pending.grant(); else w.pending.deny() } w.pending = null } }
                }
            }
        }
    }
    Rectangle {   // a short notice at the bottom
        visible: w.note !== ""
        anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: 18
        width: noteText.implicitWidth + 30; height: 36; radius: 18
        color: Theme.card; border.color: Theme.border
        Text { id: noteText; anchors.centerIn: parent; text: w.note; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
    }
}
