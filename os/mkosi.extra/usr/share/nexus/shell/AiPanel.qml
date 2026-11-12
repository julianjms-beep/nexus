import QtQuick
import QtQuick.Window
import QtQuick.Controls
import org.kde.layershell 1.0 as LayerShell

// NEXUS AI: one bar for everything (Super+Space): type and the apps, the Ajustes pages and the files that match appear
// in sections (nexus-sessiond GET /search: the same index as NEXUS Search), with «Buscar en la web» and «Preguntar a
// NEXUS AI» always at the end; ↑↓ move through all of them, ↵ runs the chosen one. A question with no match goes to
// NEXUS AI, as before.
Window {
    id: panel
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-ai"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property bool busy: false
    property int sel: -1
    property var matches: []   // the apps that match (kept: the Enter default)
    // the launcher's rows, in order: apps, Ajustes pages, files, then the web search and the question for NEXUS AI
    property var rows: []
    property var found: ({ apps: [], settings: [], files: [] })
    property int askedSeq: 0
    function lookup() {
        var q = input.text.trim(), seq = ++askedSeq
        if (q.length < 2 || q.length > 120) { found = { apps: [], settings: [], files: [] }; buildRows(); return }
        Session.request("GET", "/search?q=" + encodeURIComponent(q), null, function(st, j) {
            if (seq !== panel.askedSeq) return   // an older answer
            panel.found = st === 200 && j ? { apps: j.apps || [], settings: j.settings || [], files: j.files || [] } : { apps: [], settings: [], files: [] }
            panel.buildRows()
        })
    }
    function buildRows() {
        var q = input.text.trim(), out = []
        for (var i = 0; i < matches.length; i++) out.push({ kind: "app", id: matches[i], label: (Session.apps[matches[i]] || {}).name || matches[i], sub: "App", icon: "" })
        for (i = 0; i < found.apps.length; i++) if (matches.indexOf(found.apps[i].id) < 0 && out.length < 6) out.push({ kind: "app", id: found.apps[i].id, label: found.apps[i].name, sub: "App", icon: "" })
        for (i = 0; i < Math.min(3, found.settings.length); i++) out.push({ kind: "settings", id: found.settings[i].page, label: found.settings[i].title, sub: "Ajustes", icon: "gear" })
        for (i = 0; i < Math.min(5, found.files.length); i++) out.push({ kind: "file", id: found.files[i].path, label: found.files[i].name, sub: panel.whereIs(found.files[i].path), icon: found.files[i].dir ? "folder" : /\.(png|jpe?g|gif|webp|heic|svg)$/i.test(found.files[i].name) ? "image" : /\.(mp3|m4a|flac|wav|ogg)$/i.test(found.files[i].name) ? "music" : "doc" })
        if (q.length >= 2) {
            out.push({ kind: "web", id: q, label: "Buscar «" + q + "» en la web", sub: "NEXUS Search", icon: "globe" })
            out.push({ kind: "ai", id: q, label: "Preguntar a NEXUS AI", sub: "«" + q + "»", icon: "brain" })
        }
        rows = out
        if (sel >= rows.length) sel = rows.length - 1
        if (sel < 0 && rows.length && rows[0].kind === "app") sel = 0
    }
    function whereIs(p) {
        var parts = String(p).split("/"); parts.pop()
        var home = parts.indexOf(Session.me.user)
        var rel = home >= 0 ? parts.slice(home + 1) : parts
        return rel.length ? rel.join(" › ") : "Carpeta personal"
    }
    function run(r) {
        if (!r) return
        if (r.kind === "app") { Session.launch(r.id); close() }
        else if (r.kind === "settings") { Session.openSettings(r.id); close() }
        else if (r.kind === "file") { Session.openFolder(r.id.slice(0, r.id.lastIndexOf("/")) || r.id); close() }   // Archivos, in its folder
        else if (r.kind === "web") { Session.request("POST", "/search/open", { q: r.id }, null); close() }
        else if (r.kind === "ai") ask(r.id)
    }
    readonly property var suggestions: ["Organiza mis fotos por año", "Abre la terminal", "¿Cuánta memoria tengo?", "Pon el modo claro", "¿Qué hora es?"]

    // "shown" is what the person asked for; the window stays visible a moment longer so the bar can fade out
    property bool shown: false
    function open() {
        hideLater.stop()
        if (!shown) { if (!visible) input.text = ""; visible = true; shown = true }
        requestActivate()
        input.forceActiveFocus()
        Session.refreshApps()
    }
    function openWith(t) { open(); input.text = String(t); input.cursorPosition = input.text.length }
    function openAndAsk(t) { open(); if (!busy) ask(String(t).slice(0, 500)) }
    function close() { if (!shown) return; shown = false; hideLater.restart() }
    function toggle() { if (shown) close(); else open() }
    Timer { id: hideLater; interval: Theme.ms(150) + 10; onTriggered: if (!panel.shown) panel.visible = false }

    function norm(s) {
        var t = String(s).toLowerCase()
        try { t = t.normalize("NFD").replace(/[̀-ͯ]/g, "") } catch (e) {}
        return t
    }
    function updateMatches() {
        var q = norm(input.text.trim()), out = []
        if (q.length > 0 && q.length < 24) {
            for (var id in Session.apps) {
                var n = norm(Session.apps[id].name)
                if (n.indexOf(q) === 0 || id.indexOf(q) === 0 || (q.length >= 3 && n.indexOf(q) >= 0)) out.push(id)
            }
        }
        matches = out
        sel = out.length > 0 ? 0 : -1
        lookupLater.restart()
        buildRows()
    }
    Timer { id: lookupLater; interval: 140; onTriggered: panel.lookup() }
    function submit() {
        var t = input.text.trim()
        if (!t || busy) return
        if (sel >= 0 && sel < rows.length) { run(rows[sel]); return }
        ask(t)
    }
    function describe(actions) {
        var parts = []
        for (var i = 0; i < (actions || []).length; i++) {
            var a = actions[i]
            if (a.kind === "launch") parts.push("Abrió " + ((Session.apps[a.app] || {}).name || a.app))
            else if (a.kind === "theme") parts.push(a.mode === "dark" ? "Modo oscuro" : "Modo claro")
            else if (a.kind === "confirm") parts.push("Esperando tu confirmación")
            else if (a.kind === "automation") parts.push("Borrador en Automatizaciones")
        }
        return parts.join(" · ")
    }
    // ---- "Organiza mis fotos de waterpolo por año": the plan arrives with the answer; nothing moves until "Organizar"
    readonly property var nouns: ({ photos: ["foto", "fotos", "image"], videos: ["vídeo", "vídeos", "image"], music: ["canción", "canciones", "music"], docs: ["documento", "documentos", "doc"], all: ["archivo", "archivos", "doc"] })
    function howMany(n, what) { var w = nouns[what] || nouns.all; return n + " " + (n === 1 ? w[0] : w[1]) }
    function organize(i, approve) {
        var p = JSON.parse(chat.get(i).plan)
        if (!approve) {
            Session.request("POST", "/files/organize/cancel", { id: p.id }, null)
            chat.setProperty(i, "phase", "cancelled"); chat.setProperty(i, "body", "Vale, no he movido nada.")
            return
        }
        chat.setProperty(i, "phase", "working")
        Session.request("POST", "/files/organize", { id: p.id }, function(st, j) {
            if (st === 200 && j) {
                chat.setProperty(i, "plan", JSON.stringify(j)); chat.setProperty(i, "phase", "done"); chat.setProperty(i, "body", String(j.text || "Hecho."))
                if (j.moved > 0) Session.openFolder(j.folder)   // Archivos opens on the organised folder, as in the concept
            } else { chat.setProperty(i, "phase", "error"); chat.setProperty(i, "body", (j && j.error) ? j.error + "." : "No he podido organizarlo.") }
        })
    }
    function undoOrganize(i) {
        var p = JSON.parse(chat.get(i).plan)
        chat.setProperty(i, "phase", "working")
        Session.request("POST", "/files/organize/undo", { id: p.id }, function(st, j) {
            chat.setProperty(i, "phase", st === 200 ? "undone" : "error")
            chat.setProperty(i, "body", st === 200 && j ? String(j.text) : (j && j.error) ? j.error + "." : "No he podido deshacerlo.")
        })
    }

    function ask(t) {
        chat.append({ who: "user", body: t, note: "", pending: false, plan: "", phase: "" })
        chat.append({ who: "ai", body: "", note: "", pending: true, plan: "", phase: "" })
        input.text = ""
        busy = true
        Session.ask(t, function(ok, r) {
            panel.busy = false
            var i = chat.count - 1
            chat.setProperty(i, "pending", false)
            chat.setProperty(i, "body", String(r.text || ""))
            chat.setProperty(i, "note", panel.describe(r.actions) + (r.source === "claude" && r.model ? (panel.describe(r.actions) ? " · " : "") + "Claude" : ""))
            if (r.error) { chat.setProperty(i, "plan", JSON.stringify({ fix: r.fix || "retry", why: r.error, asked: t })); chat.setProperty(i, "phase", "aierror") }
            var launched = false
            for (var k = 0; k < (r.actions || []).length; k++) {
                if (r.actions[k].kind === "launch" || r.actions[k].kind === "automation") launched = true
                if (r.actions[k].kind === "organize" && r.actions[k].plan) {
                    // only the newest plan can be confirmed: older ones still waiting are withdrawn
                    for (var o = 0; o < i; o++) if (chat.get(o).phase === "proposed") {
                        Session.request("POST", "/files/organize/cancel", { id: JSON.parse(chat.get(o).plan).id }, null)
                        chat.setProperty(o, "phase", "superseded"); chat.setProperty(o, "note", "Sustituido por el plan de abajo")
                    }
                    chat.setProperty(i, "plan", JSON.stringify(r.actions[k].plan)); chat.setProperty(i, "phase", "proposed")
                }
            }
            if (launched) closeLater.restart()
        })
    }
    Timer { id: closeLater; interval: 900; onTriggered: panel.close() }

    // a small fact under an answer ("Imágenes › Waterpolo", "23 fotos"), as in the concept art
    component Chip: Rectangle {
        property string icon: ""
        property string label: ""
        width: chipRow.implicitWidth + 24; height: 32; radius: 12
        color: Theme.dark ? Qt.rgba(1, 1, 1, 0.06) : Theme.card2
        border.color: Theme.border
        Row {
            id: chipRow
            anchors.centerIn: parent
            spacing: 8
            LineIcon { visible: parent.parent.icon !== ""; name: parent.parent.icon; size: 16; color: Theme.dim; anchors.verticalCenter: parent.verticalCenter }
            Text { text: parent.parent.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; anchors.verticalCenter: parent.verticalCenter }
        }
    }
    component ActionButton: Rectangle {
        id: ab
        property string label: ""
        property bool primary: false
        property bool active: true
        signal clicked()
        width: abText.implicitWidth + 40; height: 40; radius: 20
        opacity: active ? 1 : 0.55
        color: primary ? (abArea.pressed ? Qt.darker(Theme.accent, 1.15) : abArea.containsMouse ? Qt.lighter(Theme.accent, 1.08) : Theme.accent)
                       : (abArea.containsMouse ? Theme.hover : (Theme.dark ? Qt.rgba(1, 1, 1, 0.05) : Theme.card2))
        border.color: primary ? "transparent" : Theme.border
        Text { id: abText; anchors.centerIn: parent; text: ab.label; color: ab.primary ? "#ffffff" : Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: ab.primary ? Font.DemiBold : Font.Medium }
        MouseArea { id: abArea; anchors.fill: parent; enabled: ab.active; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: ab.clicked() }
    }

    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0.02, 0.03, 0.06, Theme.dark ? 0.55 : 0.30)
        opacity: panel.shown ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.ms(panel.shown ? 200 : 140); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent; onClicked: panel.close() }
    }

    // the bar and its glow come in together: a quick fade, a slight drop and growth from the top (and back out)
    Item {
        id: stage
        anchors.fill: parent
        opacity: panel.shown ? 1 : 0
        property real s: panel.shown ? 1 : 0.965
        property real dy: panel.shown ? 0 : -10
        Behavior on opacity { NumberAnimation { duration: Theme.ms(panel.shown ? 170 : 130); easing.type: Easing.OutCubic } }
        Behavior on s { NumberAnimation { duration: Theme.ms(panel.shown ? 260 : 130); easing.type: Easing.OutCubic } }
        Behavior on dy { NumberAnimation { duration: Theme.ms(panel.shown ? 260 : 130); easing.type: Easing.OutCubic } }
        transform: [
            Scale { origin.x: card.x + card.width / 2; origin.y: card.y; xScale: stage.s; yScale: stage.s },
            Translate { y: stage.dy }
        ]

        // soft accent glow around the panel: two faint rings (cheap, no blur pass)
        Repeater {
            model: [[8, 0.07, 5], [3, 0.16, 3]]
            Rectangle {
                required property var modelData
                x: card.x - modelData[0]; y: card.y - modelData[0]
                width: card.width + 2 * modelData[0]; height: card.height + 2 * modelData[0]
                radius: card.radius + modelData[0]
                color: "transparent"
                border.color: Theme.alpha(Theme.accent, modelData[1]); border.width: modelData[2]
            }
        }

        Rectangle {
            id: card
            width: Math.min(720, panel.width - 48)
            x: Math.round((panel.width - width) / 2)
            y: Math.round(panel.height * 0.14)
            height: Math.min(content.implicitHeight, panel.height * 0.74)
            radius: 22
            gradient: Gradient {
                GradientStop { position: 0; color: Theme.dark ? Qt.rgba(0.11, 0.09, 0.22, 0.985) : Theme.card }
                GradientStop { position: 1; color: Theme.dark ? Qt.rgba(0.06, 0.06, 0.13, 0.985) : Theme.card }
            }
            border.color: Theme.alpha(Theme.accent, Theme.dark ? 0.55 : 0.40)
            clip: true
            MouseArea { anchors.fill: parent }

            Column {
                id: content
                width: parent.width

                Item {
                    width: parent.width; height: 84
                    // the question field sits in its own framed pill, like the concept art
                    Rectangle {
                        x: 14; width: parent.width - 28; height: 56; radius: 16
                        anchors.verticalCenter: parent.verticalCenter
                        color: Theme.dark ? Qt.rgba(1, 1, 1, 0.05) : Theme.card2
                        border.color: input.activeFocus ? Theme.alpha(Theme.accent, 0.50) : Theme.border
                    }
                    NexusMark { id: orb; x: 30; width: 28; height: 28; anchors.verticalCenter: parent.verticalCenter; spinning: panel.busy }
                    TextField {
                        id: input
                        anchors.left: orb.right; anchors.leftMargin: 14
                        anchors.right: escHint.left; anchors.rightMargin: 12
                        anchors.verticalCenter: parent.verticalCenter
                        placeholderText: panel.busy ? "Pensando…" : "Apps, archivos, ajustes, web… o pregunta a NEXUS"
                        placeholderTextColor: Theme.faint
                        color: Theme.text
                        selectionColor: Theme.alpha(Theme.accent, 0.4)
                        font.family: Theme.font; font.pixelSize: 20
                        background: Item {}
                        onTextChanged: panel.updateMatches()
                        Keys.onReturnPressed: panel.submit()
                        Keys.onEnterPressed: panel.submit()
                        Keys.onEscapePressed: panel.close()
                        Keys.onDownPressed: if (panel.rows.length) panel.sel = Math.min(panel.sel + 1, panel.rows.length - 1)
                        Keys.onUpPressed: if (panel.rows.length) panel.sel = Math.max(panel.sel - 1, -1)
                    }
                    Rectangle {
                        id: escHint
                        anchors.right: parent.right; anchors.rightMargin: 28; anchors.verticalCenter: parent.verticalCenter
                        width: escText.implicitWidth + 16; height: 26; radius: 7
                        color: Theme.hover; border.color: Theme.border
                        Text { id: escText; anchors.centerIn: parent; text: "esc"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                    }
                }

                Rectangle { width: parent.width; height: 1; color: Theme.border }

                // the launcher: apps, Ajustes, files, the web, NEXUS AI
                Column {
                    id: matchList
                    visible: panel.rows.length > 0
                    width: parent.width
                    topPadding: 8; bottomPadding: 8
                    readonly property var sectionNames: ({ app: "Apps", settings: "Ajustes", file: "Archivos", web: "Web", ai: "NEXUS AI" })
                    Repeater {
                        model: panel.rows
                        Column {
                            required property var modelData
                            required property int index
                            readonly property bool newSection: index === 0 || panel.rows[index - 1].kind !== modelData.kind
                            width: matchList.width
                            Text {
                                visible: parent.newSection
                                x: 22; height: 24; verticalAlignment: Text.AlignBottom
                                text: matchList.sectionNames[parent.modelData.kind] || ""
                                color: Theme.faint; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.DemiBold; font.letterSpacing: 0.6
                            }
                            Rectangle {
                                readonly property var r: parent.modelData
                                readonly property int i: parent.index
                                x: 8; width: matchList.width - 16; height: 48; radius: 12
                                color: i === panel.sel ? Theme.alpha(Theme.accent, 0.18) : ma.containsMouse ? Theme.hover : "transparent"
                                AppIcon { visible: parent.r.kind === "app"; app: parent.r.kind === "app" ? parent.r.id : ""; x: 12; width: 32; height: 32; anchors.verticalCenter: parent.verticalCenter }
                                Rectangle {
                                    visible: parent.r.kind !== "app"
                                    x: 12; width: 32; height: 32; radius: 9; anchors.verticalCenter: parent.verticalCenter
                                    color: Theme.alpha(parent.r.kind === "ai" ? Theme.accent : Theme.dim, 0.16)
                                    LineIcon { anchors.centerIn: parent; name: parent.parent.r.icon || "doc"; size: 17; color: parent.parent.r.kind === "ai" ? Theme.accent : Theme.text }
                                }
                                Text { x: 56; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 56 - 120; elide: Text.ElideRight; text: parent.r.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 15 }
                                Text { anchors.right: parent.right; anchors.rightMargin: 14; anchors.verticalCenter: parent.verticalCenter; text: parent.i === panel.sel ? "↵  Abrir" : parent.r.sub; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; elide: Text.ElideLeft; width: Math.min(implicitWidth, 200) }
                                MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: panel.run(parent.r) }
                            }
                        }
                    }
                }

                // suggestions (empty state)
                Flow {
                    visible: chat.count === 0 && panel.rows.length === 0
                    width: parent.width - 40; x: 20
                    topPadding: 16; bottomPadding: 16
                    spacing: 8
                    Repeater {
                        model: panel.suggestions
                        Rectangle {
                            required property string modelData
                            width: sugText.implicitWidth + 24; height: 32; radius: 16
                            color: sugArea.containsMouse ? Theme.alpha(Theme.accent, 0.16) : Theme.card2
                            border.color: Theme.border
                            Text { id: sugText; anchors.centerIn: parent; text: modelData; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                            MouseArea { id: sugArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: panel.ask(modelData) }
                        }
                    }
                }

                // conversation
                ListView {
                    id: chatView
                    visible: chat.count > 0 && panel.rows.length === 0
                    width: parent.width
                    height: Math.min(contentHeight + topMargin + bottomMargin, 400)
                    clip: true
                    spacing: 10
                    topMargin: 14; bottomMargin: 14
                    model: ListModel { id: chat }
                    onCountChanged: Qt.callLater(positionViewAtEnd)
                    delegate: Item {
                        id: row
                        required property int index
                        required property string who
                        required property string body
                        required property string note
                        required property bool pending
                        required property string plan
                        required property string phase
                        readonly property bool mine: who === "user"
                        readonly property real maxW: chatView.width * 0.80 - (mine ? 0 : 46)
                        readonly property var info: plan ? JSON.parse(plan) : null
                        readonly property bool hasExtra: info !== null && (phase === "proposed" || phase === "working" || (phase === "done" && info.moved > 0) || (phase === "aierror" && info.fix !== "none"))
                        width: chatView.width
                        height: bubble.y + bubble.height + (noteLabel.visible ? noteLabel.height + 4 : 0) + (hasExtra ? extra.height + 12 : 0)
                        // NEXUS AI's answers carry its tile and name, like the concept art
                        Image {
                            visible: !row.mine
                            x: 20; y: 2; width: 34; height: 34
                            source: Qt.resolvedUrl("../icons/nexus-tile.svg"); sourceSize: Qt.size(68, 68)
                        }
                        Text {
                            visible: !row.mine
                            x: 66; y: 0
                            text: "NEXUS AI"
                            color: Theme.dim
                            font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
                        }
                        Rectangle {
                            id: bubble
                            x: row.mine ? row.width - width - 20 : 66
                            y: row.mine ? 0 : 20
                            width: Math.min(Math.max(msg.implicitWidth, row.pending ? 70 : 0), row.maxW - 28) + 28
                            height: (row.pending ? 20 : msg.height) + 20
                            radius: 16
                            color: row.mine ? Theme.accent : (Theme.dark ? Qt.rgba(1, 1, 1, 0.07) : Theme.card2)
                            border.color: row.mine ? "transparent" : Theme.border
                            Text {
                                id: msg
                                x: 14; y: 10
                                visible: !row.pending
                                width: Math.min(implicitWidth, row.maxW - 28)
                                text: row.body
                                wrapMode: Text.Wrap
                                color: row.mine ? "#ffffff" : Theme.text
                                font.family: Theme.font; font.pixelSize: 15
                                lineHeight: 1.15
                            }
                            Row {
                                visible: row.pending
                                anchors.centerIn: parent
                                spacing: 6
                                Repeater {
                                    model: 3
                                    Rectangle {
                                        required property int index
                                        width: 7; height: 7; radius: 3.5; color: Theme.dim
                                        SequentialAnimation on opacity {
                                            loops: Animation.Infinite; running: row.pending
                                            PauseAnimation { duration: index * 160 }
                                            NumberAnimation { from: 0.25; to: 1; duration: 300 }
                                            NumberAnimation { from: 1; to: 0.25; duration: 300 }
                                            PauseAnimation { duration: (2 - index) * 160 }
                                        }
                                    }
                                }
                            }
                        }
                        Text {
                            id: noteLabel
                            visible: row.note !== "" && !row.mine
                            anchors.top: bubble.bottom; anchors.topMargin: 4
                            x: 72
                            text: row.note
                            color: Theme.faint
                            font.family: Theme.font; font.pixelSize: 11
                        }
                        // the organising plan: what, where, into which folders, and the person's choice
                        Column {
                            id: extra
                            visible: row.hasExtra
                            x: 66; width: row.width - 66 - 20
                            y: bubble.y + bubble.height + (noteLabel.visible ? noteLabel.height + 4 : 0) + 12
                            spacing: 12
                            // what to do when Claude could not answer (the words come from the Engine: core/src/ai-errors.ts)
                            Row {
                                visible: row.phase === "aierror"
                                spacing: 10
                                ActionButton { visible: row.info && row.info.fix === "settings-ai"; primary: true; label: "Abrir Ajustes → NEXUS AI"; onClicked: { Session.openSettings("ai"); panel.close() } }
                                ActionButton { visible: row.info && row.info.fix === "network"; primary: true; label: "Abrir Ajustes → Wi-Fi"; onClicked: { Session.openSettings("wifi"); panel.close() } }
                                ActionButton { visible: row.info && (row.info.fix === "retry" || row.info.fix === "wait" || row.info.fix === "network"); primary: row.info && row.info.fix !== "network"; label: "Reintentar"; onClicked: panel.ask(row.info.asked) }
                            }
                            Flow {
                                visible: row.phase !== "aierror"
                                width: parent.width; spacing: 8
                                Chip { visible: row.phase === "done"; icon: "open"; label: "Abrió Archivos" }
                                Chip { visible: row.phase !== "done"; icon: "folder"; label: row.info ? row.info.place : "" }
                                Chip { icon: row.info ? (panel.nouns[row.info.what] || panel.nouns.all)[2] : "doc"; label: row.info ? panel.howMany(row.phase === "done" ? row.info.moved : row.info.total, row.info.what) : "" }
                            }
                            Flow {
                                visible: row.phase !== "done" && row.info !== null && row.info.groups.length > 0
                                width: parent.width; spacing: 6
                                Repeater {
                                    model: row.info ? row.info.groups.slice(0, 6) : []
                                    Rectangle {
                                        required property var modelData
                                        width: gRow.implicitWidth + 18; height: 28; radius: 9
                                        color: Theme.alpha(Theme.accent, Theme.dark ? 0.12 : 0.08)
                                        border.color: Theme.alpha(Theme.accent, 0.28)
                                        Row {
                                            id: gRow
                                            anchors.centerIn: parent; spacing: 6
                                            LineIcon { name: "folder"; size: 14; color: Theme.accent; anchors.verticalCenter: parent.verticalCenter }
                                            Text { text: modelData.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.Medium; anchors.verticalCenter: parent.verticalCenter }
                                            Text { text: String(modelData.count); color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; anchors.verticalCenter: parent.verticalCenter }
                                        }
                                    }
                                }
                                Text {
                                    visible: row.info !== null && row.info.groups.length > 6
                                    height: 28; verticalAlignment: Text.AlignVCenter
                                    text: row.info ? "+" + (row.info.groups.length - 6) + " más" : ""
                                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                                }
                            }
                            Row {
                                spacing: 10
                                ActionButton {
                                    visible: row.phase === "proposed" || (row.phase === "working" && !(row.info && row.info.moved !== undefined))
                                    primary: true; active: row.phase === "proposed"
                                    label: row.phase === "working" ? "Organizando…" : "Organizar"
                                    onClicked: panel.organize(row.index, true)
                                }
                                ActionButton {
                                    visible: row.phase === "proposed"
                                    label: "Cancelar"
                                    onClicked: panel.organize(row.index, false)
                                }
                                ActionButton {
                                    visible: (row.phase === "done" || row.phase === "working") && row.info !== null && row.info.moved !== undefined && !!row.info.show
                                    primary: true; active: row.phase === "done"
                                    label: row.info && row.info.show ? "Enséñame " + row.info.show.label : ""
                                    onClicked: Session.openFolder(row.info.show.path)
                                }
                                ActionButton {
                                    visible: (row.phase === "done" || row.phase === "working") && row.info !== null && row.info.moved > 0
                                    active: row.phase === "done"
                                    label: row.phase === "working" ? "Deshaciendo…" : "Deshacer"
                                    onClicked: panel.undoOrganize(row.index)
                                }
                            }
                        }
                    }
                }

                Rectangle { width: parent.width; height: 1; color: Theme.border }
                Item {
                    width: parent.width; height: 36
                    Text {
                        x: 20; anchors.verticalCenter: parent.verticalCenter
                        text: "↵ Preguntar      ↑↓ Elegir app      esc Cerrar"
                        color: Theme.faint; font.family: Theme.font; font.pixelSize: 11
                    }
                    Row {
                        anchors.right: parent.right; anchors.rightMargin: 20; anchors.verticalCenter: parent.verticalCenter
                        spacing: 6
                        Rectangle { width: 6; height: 6; radius: 3; anchors.verticalCenter: parent.verticalCenter; color: !Session.engineUp ? Theme.danger : Session.aiConfigured ? Theme.good : Theme.warn }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: !Session.engineUp ? "Motor sin conexión" : Session.aiConfigured ? "Claude Opus 5.5" : "Sin clave: solo órdenes locales"
                            color: Theme.faint; font.family: Theme.font; font.pixelSize: 11
                        }
                    }
                }
            }
        }
    }
}
