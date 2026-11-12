import QtQuick
import QtQuick.Controls
import "../shell"

// NEXUS Store → «Apps de Linux» (apps/Store.qml shows it): the programs of desktop Linux from Flathub's catalogue
// (core/src/linuxapps.ts, nexus-sessiond /store/linux). A grid to search and browse; a page per app that says how
// much it weighs and, in plain words, what it will be able to reach, before the Install button.
Item {
    id: v
    property var apps: []                 // the catalogue: what the search found, or the most installed
    property var installed: []            // [{ id, name, version, size }]
    property bool available: true         // is flatpak on this computer?
    property bool loading: false
    property string error: ""
    property bool onlyInstalled: false
    property var page: null               // the open app (GET /store/linux/app), or null
    property string pageError: ""
    property string confirmRemove: ""
    readonly property var installedIds: { var s = ({}); for (var i = 0; i < installed.length; i++) s[installed[i].id] = true; return s }

    function load() {
        loading = true
        Session.request("GET", "/store/linux?q=" + encodeURIComponent(find.text.trim()), null, function(st, j) {
            v.loading = false
            if (st === 200 && j) { v.apps = j.apps || []; v.installed = j.installed || []; v.available = j.available !== false; v.error = j.error || "" }
            else v.error = j && j.error ? j.error : "No se ha podido leer el catálogo."
        })
    }
    function open(id) {
        pageError = ""; confirmRemove = ""
        Session.request("GET", "/store/linux/app?id=" + encodeURIComponent(id), null, function(st, j) {
            if (st === 200 && j) v.page = j
            else if (v.page === null) v.error = j && j.error ? j.error : "No se ha podido abrir la app."
        })
    }
    function install() {
        Session.request("POST", "/store/linux/install", { id: page.id }, function(st, j) {
            if (st === 200 && j && j.job) { var p = v.page; p.job = j.job; v.page = p; v.pageError = "" }
            else v.pageError = j && j.error ? j.error : "No se ha podido instalar."
        })
    }
    function remove() {
        if (confirmRemove !== page.id) { confirmRemove = page.id; return }
        confirmRemove = ""
        Session.request("POST", "/store/linux/remove", { id: page.id, data: true }, function(st, j) {
            if (st === 200 && j) { v.installed = j.installed || []; v.open(v.page.id) }
            else v.pageError = j && j.error ? j.error : "No se ha podido quitar."
        })
    }
    function launch(id) { Session.request("POST", "/store/linux/open", { id: id }, function(st, j) { if (st !== 200) v.pageError = j && j.error ? j.error : "No se ha podido abrir." }) }
    onVisibleChanged: if (visible && apps.length === 0) load()
    Component.onCompleted: if (visible) load()
    // while an app is being installed, its page follows the progress
    Timer {
        interval: 1000; repeat: true
        running: v.visible && v.page !== null && v.page.job !== null && v.page.job !== undefined && v.page.job.state === "running"
        onTriggered: v.open(v.page.id)
        onRunningChanged: if (!running && v.visible) v.load()
    }
    Timer { id: typing; interval: 350; onTriggered: v.load() }

    component Btn: Rectangle {
        id: bt
        property string label: ""
        property bool primary: false
        property color tint: Theme.accent
        signal clicked()
        width: btText.implicitWidth + 30; height: 36; radius: 18
        opacity: enabled ? 1 : 0.5
        color: primary ? (btArea.pressed ? Qt.darker(tint, 1.2) : tint) : btArea.containsMouse ? Theme.alpha(tint, 0.18) : Theme.alpha(tint, 0.10)
        Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
        Text { id: btText; anchors.centerIn: parent; text: bt.label; color: bt.primary ? "#ffffff" : bt.tint; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
        MouseArea { id: btArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bt.clicked() }
    }
    // an app's icon from Flathub; a tile with its first letter until it arrives (or without Internet)
    component Icon: Item {
        id: ic
        property string source: ""
        property string name: ""
        Rectangle { anchors.fill: parent; radius: width * 0.26; visible: img.status !== Image.Ready
            gradient: Gradient { GradientStop { position: 0; color: Qt.lighter(Theme.accent, 1.2) } GradientStop { position: 1; color: Theme.accent } }
            Text { anchors.centerIn: parent; text: ic.name.charAt(0).toUpperCase(); color: "#ffffff"; font.family: Theme.font; font.pixelSize: parent.width * 0.46; font.weight: Font.Bold } }
        Image { id: img; anchors.fill: parent; source: ic.source; asynchronous: true; fillMode: Image.PreserveAspectFit; sourceSize.width: 128; sourceSize.height: 128; smooth: true }
    }

    // ---------------- search
    Row {
        id: top
        width: parent.width; spacing: 12
        TextField {
            id: find
            width: parent.width - mine.width - 12
            placeholderText: "Buscar entre miles de apps: Firefox, LibreOffice, GIMP, VLC…"
            color: Theme.text; placeholderTextColor: Theme.faint
            font.family: Theme.font; font.pixelSize: 14; leftPadding: 14
            background: Rectangle { implicitHeight: 40; radius: 12; color: Theme.card2; border.color: find.activeFocus ? Theme.accent : Theme.border; border.width: find.activeFocus ? 2 : 1 }
            onTextChanged: { v.onlyInstalled = false; typing.restart() }
        }
        Btn { id: mine; height: 40; radius: 12; label: "Instaladas" + (v.installed.length ? "  " + v.installed.length : ""); primary: v.onlyInstalled; onClicked: v.onlyInstalled = !v.onlyInstalled }
    }
    Text {
        id: note
        anchors.top: top.bottom; anchors.topMargin: 10
        width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
        visible: text !== ""
        text: !v.available ? "A este equipo le falta el instalador de apps de Linux. Llega con la próxima actualización de NEXUS; mientras, puedes mirar el catálogo."
            : v.error !== "" ? v.error : ""
        color: Theme.warn; font.family: Theme.font; font.pixelSize: 13
    }

    // ---------------- the grid
    Flickable {
        id: flick
        anchors.top: note.visible ? note.bottom : top.bottom; anchors.topMargin: 16; anchors.bottom: parent.bottom
        width: parent.width
        contentWidth: width; contentHeight: grid.height + 12
        clip: true; boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Flow {
            id: grid
            width: flick.width - 12
            spacing: 14
            readonly property int cols: Math.max(1, Math.floor((width + 14) / 344))
            readonly property real cardW: Math.floor((width - 14 * (cols - 1)) / cols)
            Repeater {
                model: v.onlyInstalled ? v.installed : v.apps
                Rectangle {
                    id: card
                    required property var modelData
                    readonly property bool have: v.installedIds[modelData.id] === true
                    width: grid.cardW; height: 112; radius: 18
                    color: Theme.card; border.color: ma.containsMouse ? Theme.alpha(Theme.accent, 0.7) : Theme.border
                    Behavior on border.color { ColorAnimation { duration: Theme.ms(140) } }
                    MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: v.open(card.modelData.id) }
                    Icon { x: 16; y: 16; width: 56; height: 56; source: card.modelData.icon || ""; name: card.modelData.name }
                    Column {
                        x: 86; y: 15; width: parent.width - 102; spacing: 3
                        Row { spacing: 6; width: parent.width
                            Text { width: Math.min(implicitWidth, parent.width - 22); elide: Text.ElideRight; text: card.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold }
                            Text { visible: card.modelData.verified === true; text: "✓"; color: Theme.accent; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.Bold } }
                        Text { width: parent.width; wrapMode: Text.Wrap; elide: Text.ElideRight; maximumLineCount: 2; lineHeight: 1.15
                            text: card.modelData.summary || (card.modelData.version ? "Versión " + card.modelData.version + (card.modelData.size ? " · " + card.modelData.size : "") : ""); color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                    Text { x: 16; anchors.bottom: parent.bottom; anchors.bottomMargin: 12; text: card.have ? "✓ Instalada" : (card.modelData.category || ""); color: card.have ? Theme.good : Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                }
            }
        }
        Text {
            visible: !v.loading && (v.onlyInstalled ? v.installed.length === 0 : v.apps.length === 0 && v.error === "")
            anchors.horizontalCenter: parent.horizontalCenter; y: 60
            text: v.onlyInstalled ? "Aún no has instalado ninguna app de Linux." : "No hay ninguna app con esas palabras."
            color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
        }
        Text { visible: v.loading && v.apps.length === 0; anchors.horizontalCenter: parent.horizontalCenter; y: 60; text: "Leyendo el catálogo…"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
    }

    // ---------------- one app's page, over the grid
    Rectangle {
        anchors.fill: parent; anchors.margins: -24
        visible: v.page !== null
        color: Theme.bg
        MouseArea { anchors.fill: parent }   // nothing behind is clickable
        Flickable {
            anchors.fill: parent; anchors.margins: 24
            contentWidth: width; contentHeight: pg.height + 20
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: pg
                width: parent.width - 12; spacing: 18
                readonly property var a: v.page || ({})
                readonly property var job: a.job || null
                readonly property bool busy: job !== null && job.state === "running"
                readonly property color tone: a.risk === "alto" ? Theme.warn : a.risk === "medio" ? Theme.accent : Theme.good
                Btn { label: "‹  Volver"; height: 32; onClicked: { v.page = null; v.load() } }
                Row {
                    width: parent.width; spacing: 18
                    Icon { width: 96; height: 96; source: pg.a.icon || ""; name: pg.a.name || "" }
                    Column {
                        width: parent.width - 96 - 18 - actions.width - 18; spacing: 4; anchors.verticalCenter: parent.verticalCenter
                        Row { spacing: 8
                            Text { text: pg.a.name || ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold }
                            Rectangle { visible: pg.a.verified === true; anchors.verticalCenter: parent.verticalCenter; width: vt.implicitWidth + 16; height: 22; radius: 11; color: Theme.alpha(Theme.accent, 0.16)
                                Text { id: vt; anchors.centerIn: parent; text: "✓ Verificada"; color: Theme.accent; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.DemiBold } } }
                        Text { width: parent.width; wrapMode: Text.Wrap; text: pg.a.summary || ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
                        Text { text: [pg.a.developer, pg.a.version ? "versión " + pg.a.version : "", pg.a.download ? pg.a.download + " de descarga" : "", pg.a.size ? pg.a.size + " instalada" : ""].filter(function(x) { return x }).join("  ·  ")
                            color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                    }
                    Column {
                        id: actions
                        spacing: 8; anchors.verticalCenter: parent.verticalCenter
                        Btn { visible: pg.a.installed === true && !pg.busy; anchors.right: parent.right; label: "Abrir"; primary: true; onClicked: v.launch(pg.a.id) }
                        Btn { visible: pg.a.installed === true && !pg.busy; anchors.right: parent.right; label: v.confirmRemove === pg.a.id ? "¿Seguro? Se borran sus datos" : "Quitar"; tint: Theme.danger; height: 30; onClicked: v.remove() }
                        Btn { visible: pg.a.installed !== true && !pg.busy; anchors.right: parent.right; label: "Instalar"; primary: true; tint: Theme.good; enabled: v.available; onClicked: v.install() }
                        // progress while it downloads and installs. flatpak gives no percentage when nobody is at a
                        // terminal, so without one the bar just moves: it says "working", not "how much"
                        Column { visible: pg.busy; spacing: 6; width: 220
                            Text { text: pg.job && pg.job.percent > 0 ? "Instalando… " + pg.job.percent + " %" : "Descargando e instalando…"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                            Rectangle { id: track; width: 220; height: 6; radius: 3; color: Theme.card2; clip: true
                                Rectangle { visible: pg.job !== null && pg.job.percent > 0; width: parent.width * ((pg.job ? pg.job.percent : 0) / 100); height: 6; radius: 3; color: Theme.good
                                    Behavior on width { NumberAnimation { duration: Theme.ms(400) } } }
                                Rectangle { visible: pg.job === null || pg.job.percent === 0; width: 70; height: 6; radius: 3; color: Theme.good
                                    SequentialAnimation on x { loops: Animation.Infinite; running: pg.busy && v.visible
                                        NumberAnimation { from: -70; to: 220; duration: 1300; easing.type: Easing.InOutQuad } } } }
                            Text { width: 220; wrapMode: Text.Wrap; lineHeight: 1.15; text: "Puede tardar unos minutos. Puedes seguir usando el equipo."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 } }
                    }
                }
                Text { visible: text !== ""; width: parent.width; wrapMode: Text.Wrap
                    text: v.pageError !== "" ? v.pageError : pg.job !== null && pg.job.state === "failed" ? (pg.job.error || "No se ha podido instalar.") : ""
                    color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }

                // what the app will be able to reach, before installing
                Rectangle {
                    width: parent.width; height: permCol.height + 32; radius: 16; color: Theme.card
                    border.color: Theme.alpha(pg.tone, 0.4)
                    Column {
                        id: permCol
                        x: 18; y: 16; width: parent.width - 36; spacing: 9
                        Row { spacing: 10
                            LineIcon { name: "shield"; color: pg.tone; size: 20 }
                            Text { text: pg.a.risk === "alto" ? "Esta app pide mucho acceso" : pg.a.risk === "medio" ? "Lo que esta app puede hacer" : "Esta app está bien aislada"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold } }
                        Repeater {
                            model: pg.a.permissions || []
                            Row { required property var modelData; spacing: 10
                                Rectangle { anchors.verticalCenter: parent.verticalCenter; width: 8; height: 8; radius: 4; color: modelData.level === "alto" ? Theme.warn : modelData.level === "medio" ? Theme.accent : Theme.good }
                                Text { text: modelData.text; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 } }
                        }
                        Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                            text: "Cada app de Linux se ejecuta en su propio espacio. Lo que no aparece en esta lista, no puede tocarlo."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                        Text { visible: v.installed.length === 0 && pg.a.installed !== true; width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                            text: "Tu primera app de Linux descarga además la base que comparten todas (entre 1 y 2 GB). Las siguientes ocupan solo lo suyo."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                    }
                }

                // screenshots
                ListView {
                    visible: count > 0
                    width: parent.width; height: 260; orientation: ListView.Horizontal; spacing: 12; clip: true
                    model: pg.a.screenshots || []
                    delegate: Rectangle {
                        required property string modelData
                        width: 462; height: 260; radius: 12; color: Theme.card2; clip: true
                        Image { anchors.fill: parent; source: modelData; asynchronous: true; fillMode: Image.PreserveAspectFit; sourceSize.width: 924 }
                    }
                }
                Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.3; text: pg.a.description || ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
                Text { visible: (pg.a.license || "") !== ""; text: "Licencia: " + (pg.a.license || "") + (pg.a.homepage ? "   ·   " + String(pg.a.homepage).replace(/^https:\/\//, "").replace(/\/$/, "") : ""); color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
            }
        }
    }
}
