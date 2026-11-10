import QtQuick
import QtQuick.Window
import QtQuick.Controls
import "../shell"

// NEXUS Mail: your iCloud, Gmail or any IMAP account (core/src/mail.ts; app passwords, never the real one).
// Three columns: accounts and folders, the messages, the message. On top of the list, what NEXUS adds: a briefing of
// the inbox by NEXUS AI and "nobody answered this in a week". Messages are shown as text (no remote images, so
// nobody learns that you opened them). A reply drafted by NEXUS AI is only a draft: it leaves when you press Enviar.
Window {
    id: w
    visible: true
    width: 1180; height: 760
    minimumWidth: 760; minimumHeight: 480
    title: "NEXUS Mail"
    color: Theme.bg

    property var info: null             // GET /mail: accounts (no passwords) and presets
    property string account: ""
    property string folder: "inbox"
    property var messages: []
    property bool loading: false
    property string err: ""
    property var open: null             // the message being read
    property bool reading: false
    property string brief: ""           // NEXUS AI's summary
    property bool briefing: false
    property var pendingReplies: null   // followups
    property bool setup: false          // the "add account" sheet
    property string kind: "icloud"
    property string setupMsg: ""
    property bool setupBusy: false
    property bool composing: false
    property var replyTo: null
    property string sendMsg: ""
    property bool sending: false
    property bool drafting: false
    readonly property var acc: { var l = info ? info.accounts : []; for (var i = 0; i < l.length; i++) if (l[i].id === account) return l[i]; return null }
    readonly property var preset: { var l = info ? info.presets : []; for (var i = 0; i < l.length; i++) if (l[i].id === kind) return l[i]; return null }

    function loadInfo(pick) {
        Session.request("GET", "/mail", null, function(st, j) {
            if (st !== 200 || !j) return
            w.info = j
            if (!j.accounts.length) { w.account = ""; w.setup = true; return }
            if (pick || !w.acc) w.account = pick || j.accounts[0].id
            w.refresh()
        })
    }
    function refresh() {
        if (!account) return
        loading = true; err = ""
        var a = account, f = folder
        Session.request("GET", "/mail/list?account=" + encodeURIComponent(a) + "&folder=" + f, null, function(st, j) {
            if (a !== w.account || f !== w.folder) return
            w.loading = false
            if (st === 200 && j) w.messages = j.messages; else { w.messages = []; w.err = j && j.error ? j.error : "No se ha podido leer el correo." }
        })
    }
    function pickFolder(f) { folder = f; open = null; messages = []; refresh() }
    function read(m) {
        reading = true; open = m
        Session.request("GET", "/mail/read?account=" + encodeURIComponent(account) + "&folder=" + folder + "&uid=" + m.uid, null, function(st, j) {
            w.reading = false
            if (st === 200 && j && w.open && w.open.uid === m.uid) {
                w.open = j.message
                var l = w.messages.slice(); for (var i = 0; i < l.length; i++) if (l[i].uid === m.uid) { var c = JSON.parse(JSON.stringify(l[i])); c.seen = true; l[i] = c }
                w.messages = l
            } else if (st !== 200) w.err = j && j.error ? j.error : "No se ha podido abrir el mensaje."
        })
    }
    function remove(m) {
        Session.request("POST", "/mail/delete", { account: account, folder: folder, uid: m.uid }, function(st, j) {
            if (st === 200) { w.open = null; w.messages = w.messages.filter(function(x) { return x.uid !== m.uid }) } else w.err = j && j.error ? j.error : "No se ha podido borrar."
        })
    }
    function summarise() {
        briefing = true; brief = ""
        Session.request("GET", "/mail/summary?account=" + encodeURIComponent(account), null, function(st, j) { w.briefing = false; w.brief = st === 200 && j ? j.text : (j && j.error ? j.error : "NEXUS AI no ha podido resumir ahora.") })
    }
    function followups() {
        pendingReplies = { loading: true, items: [] }
        Session.request("GET", "/mail/followups?account=" + encodeURIComponent(account) + "&days=7", null, function(st, j) { w.pendingReplies = st === 200 && j ? j : { items: [], error: j && j.error ? j.error : "No se ha podido comprobar." } })
    }
    function compose(reply) {
        replyTo = reply || null; sendMsg = ""; composing = true
        toField.text = reply ? reply.from.email : ""
        subjField.text = reply ? (/^re:/i.test(reply.subject) ? reply.subject : "Re: " + reply.subject) : ""
        bodyArea.text = reply ? "\n\n" + "El " + Qt.formatDateTime(new Date(reply.date), "d MMM yyyy, HH:mm") + ", " + reply.from.name + " escribió:\n" + String(reply.text || "").split("\n").map(function(l) { return "> " + l }).join("\n").slice(0, 6000) : ""
        if (reply) { bodyArea.forceActiveFocus(); bodyArea.cursorPosition = 0 } else toField.forceActiveFocus()
    }
    function send() {
        if (sending) return
        sending = true; sendMsg = ""
        var b = { account: account, to: toField.text, subject: subjField.text, body: bodyArea.text }
        if (replyTo) { b.inReplyTo = replyTo.id; b.references = ((replyTo.references || "") + " " + replyTo.id).trim() }
        Session.request("POST", "/mail/send", b, function(st, j) {
            w.sending = false
            if (st === 200) { w.composing = false; Session.toast("Correo enviado", "good"); if (w.folder === "sent") w.refresh() }
            else w.sendMsg = j && j.error ? j.error : "No se ha podido enviar."
        })
    }
    function draftWithAi() {
        if (!replyTo || drafting) return
        drafting = true
        Session.request("POST", "/mail/draft", { account: account, folder: folder, uid: replyTo.uid, hint: hintField.text }, function(st, j) {
            w.drafting = false
            if (st === 200 && j && j.text) { var quoted = bodyArea.text.indexOf("\n\nEl "); bodyArea.text = j.text + (quoted >= 0 ? bodyArea.text.slice(quoted) : "") }
            else w.sendMsg = j && j.error ? j.error : "NEXUS AI no ha podido escribir el borrador."
        })
    }
    function addAccount() {
        if (setupBusy) return
        setupBusy = true; setupMsg = ""
        var b = { kind: kind, name: nameField.text, email: emailField.text, password: passField.text }
        if (preset && preset.custom) { b.imapHost = imapField.text; b.smtpHost = smtpField.text }
        Session.request("POST", "/mail/accounts", b, function(st, j) {
            w.setupBusy = false
            if (st === 200 && j) { passField.text = ""; w.setup = false; w.info = j; w.loadInfo(j.accounts[j.accounts.length - 1].id) }
            else w.setupMsg = j && j.error ? j.error : "No se ha podido añadir la cuenta."
        })
    }
    function when(iso) {
        if (!iso) return ""
        var d = new Date(iso), t = new Date()
        return d.toDateString() === t.toDateString() ? Qt.formatTime(d, "HH:mm") : d.getFullYear() === t.getFullYear() ? Qt.formatDate(d, "d MMM") : Qt.formatDate(d, "d MMM yy")
    }
    Component.onCompleted: loadInfo("")

    component Btn: Rectangle {
        id: bt
        property string label: ""
        property bool primary: false
        property color tint: Theme.accent
        signal clicked()
        width: btText.implicitWidth + 26; height: 34; radius: 11
        opacity: enabled ? 1 : 0.5
        color: primary ? (btArea.pressed ? Qt.darker(tint, 1.2) : tint) : btArea.containsMouse ? Theme.alpha(tint, 0.18) : Theme.alpha(tint, 0.10)
        Text { id: btText; anchors.centerIn: parent; text: bt.label; color: bt.primary ? "#ffffff" : bt.tint; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
        MouseArea { id: btArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bt.clicked() }
    }
    component Field: TextField {
        id: fd
        color: Theme.text; placeholderTextColor: Theme.faint
        font.family: Theme.font; font.pixelSize: 14; leftPadding: 12
        background: Rectangle { implicitHeight: 38; radius: 10; color: Theme.card2; border.color: fd.activeFocus ? Theme.accent : Theme.border; border.width: fd.activeFocus ? 2 : 1 }
    }

    // ---------------- accounts and folders
    Rectangle {
        id: side
        width: 216; height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Column {
            x: 12; y: 16; width: parent.width - 24; spacing: 4
            Row { spacing: 10; leftPadding: 6; bottomPadding: 10
                AppIcon { app: "mail"; width: 30; height: 30 }
                Text { text: "Mail"; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter } }
            Btn { width: parent.width; height: 38; label: "Redactar"; primary: true; enabled: w.acc !== null; onClicked: w.compose(null) }
            Item { width: 1; height: 8 }
            Repeater {
                model: [["inbox", "Entrada", "mail"], ["sent", "Enviados", "send"], ["trash", "Papelera", "trash"]]
                Rectangle {
                    required property var modelData
                    readonly property bool on: w.folder === modelData[0]
                    width: parent.width; height: 36; radius: 10
                    color: on ? Theme.alpha(Theme.accent, 0.18) : fa.containsMouse ? Theme.hover : "transparent"
                    LineIcon { x: 10; anchors.verticalCenter: parent.verticalCenter; name: modelData[2]; color: on ? Theme.text : Theme.dim; size: 17 }
                    Text { x: 38; anchors.verticalCenter: parent.verticalCenter; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 14; font.weight: on ? Font.DemiBold : Font.Normal }
                    MouseArea { id: fa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.pickFolder(modelData[0]) }
                }
            }
            Text { text: "CUENTAS"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.DemiBold; font.letterSpacing: 1; leftPadding: 8; topPadding: 14; bottomPadding: 2 }
            Repeater {
                model: w.info ? w.info.accounts : []
                Rectangle {
                    required property var modelData
                    readonly property bool on: w.account === modelData.id
                    width: parent.width; height: 44; radius: 10
                    color: on ? Theme.alpha(Theme.text, 0.07) : aa.containsMouse ? Theme.hover : "transparent"
                    Column { x: 10; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 20
                        Text { width: parent.width; elide: Text.ElideRight; text: modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                        Text { width: parent.width; elide: Text.ElideRight; text: modelData.email; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 } }
                    MouseArea { id: aa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { w.account = modelData.id; w.open = null; w.brief = ""; w.pendingReplies = null; w.refresh() } }
                }
            }
            Btn { width: parent.width; label: "＋ Añadir cuenta"; onClicked: { w.setupMsg = ""; w.setup = true } }
        }
    }

    // ---------------- the messages
    Rectangle {
        id: listPane
        anchors.left: side.right; width: 380; height: parent.height
        color: Theme.bg
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Column {
            id: tools
            x: 12; y: 12; width: parent.width - 24; spacing: 8
            Row {
                spacing: 8
                Btn { label: w.briefing ? "Resumiendo…" : "✦ Resumen de NEXUS AI"; enabled: !w.briefing && w.acc !== null && w.folder === "inbox"; onClicked: w.summarise() }
                Btn { label: "Sin respuesta"; tint: Theme.warn; enabled: w.acc !== null; onClicked: w.followups() }
                Btn { label: "↻"; width: 34; enabled: !w.loading; onClicked: w.refresh() }
            }
            Rectangle {   // NEXUS AI's briefing
                visible: w.brief !== "" || w.briefing
                width: parent.width; height: briefText.implicitHeight + 24; radius: 14
                color: Theme.alpha(Theme.accent, 0.10); border.color: Theme.alpha(Theme.accent, 0.35)
                Text { id: briefText; x: 12; y: 12; width: parent.width - 44; wrapMode: Text.Wrap; lineHeight: 1.25
                    text: w.briefing ? "NEXUS AI está leyendo la bandeja…" : w.brief; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                Text { anchors.right: parent.right; anchors.rightMargin: 10; y: 8; text: "✕"; color: Theme.dim; font.pixelSize: 13
                    MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: w.brief = "" } }
            }
            Rectangle {   // sent more than a week ago, no answer
                visible: w.pendingReplies !== null
                width: parent.width; height: fuCol.height + 22; radius: 14
                color: Theme.alpha(Theme.warn, 0.10); border.color: Theme.alpha(Theme.warn, 0.35)
                Column {
                    id: fuCol
                    x: 12; y: 11; width: parent.width - 44; spacing: 4
                    Text { width: parent.width; wrapMode: Text.Wrap
                        text: !w.pendingReplies ? "" : w.pendingReplies.loading ? "Mirando lo que enviaste…" : w.pendingReplies.error ? w.pendingReplies.error
                            : w.pendingReplies.items.length ? "Enviaste esto hace más de una semana y nadie ha respondido:" : "Todo lo que enviaste hace más de una semana tiene respuesta."
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    Repeater {
                        model: w.pendingReplies && w.pendingReplies.items ? w.pendingReplies.items : []
                        Text { required property var modelData; width: parent.width; elide: Text.ElideRight
                            text: "• " + (modelData.to[0] ? modelData.to[0].name : "") + " — " + modelData.subject + " (" + w.when(modelData.date) + ")"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                }
                Text { anchors.right: parent.right; anchors.rightMargin: 10; y: 8; text: "✕"; color: Theme.dim; font.pixelSize: 13
                    MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: w.pendingReplies = null } }
            }
            Text { visible: w.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: w.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
        }
        ListView {
            anchors.top: tools.bottom; anchors.topMargin: 8; anchors.bottom: parent.bottom
            width: parent.width - 1
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            model: w.messages
            delegate: Rectangle {
                required property var modelData
                readonly property bool on: w.open !== null && w.open.uid === modelData.uid
                width: ListView.view.width; height: 66
                color: on ? Theme.alpha(Theme.accent, 0.16) : la.containsMouse ? Theme.hover : "transparent"
                Rectangle { visible: !modelData.seen; x: 9; y: 15; width: 8; height: 8; radius: 4; color: Theme.accent }
                Text { x: 24; y: 10; width: parent.width - 100; elide: Text.ElideRight
                    text: w.folder === "sent" ? "Para: " + (modelData.to[0] ? modelData.to[0].name : "") : modelData.from.name
                    color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: modelData.seen ? Font.Normal : Font.DemiBold }
                Text { visible: modelData.vip === true; anchors.right: dateText.left; anchors.rightMargin: 6; y: 11; text: "★"; color: Theme.warn; font.pixelSize: 12 }
                Text { id: dateText; anchors.right: parent.right; anchors.rightMargin: 12; y: 12; text: w.when(modelData.date); color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                Text { x: 24; y: 33; width: parent.width - 40; elide: Text.ElideRight; text: modelData.subject; color: modelData.seen ? Theme.dim : Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                Rectangle { anchors.bottom: parent.bottom; x: 24; width: parent.width - 24; height: 1; color: Theme.border }
                MouseArea { id: la; anchors.fill: parent; hoverEnabled: true; onClicked: w.read(modelData) }
            }
            Text { visible: !w.loading && w.messages.length === 0 && w.err === "" && w.acc !== null; anchors.horizontalCenter: parent.horizontalCenter; y: 40; text: "No hay mensajes aquí."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
            Text { visible: w.loading; anchors.horizontalCenter: parent.horizontalCenter; y: 40; text: "Cargando…"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
        }
    }

    // ---------------- the message
    Item {
        anchors.left: listPane.right; anchors.right: parent.right; height: parent.height
        Text { visible: w.open === null; anchors.centerIn: parent; text: w.acc ? "Elige un mensaje" : "Añade una cuenta para empezar"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 15 }
        Flickable {
            visible: w.open !== null
            anchors.fill: parent; anchors.margins: 22
            contentWidth: width; contentHeight: msgCol.height + 20
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: msgCol
                width: parent.width - 10; spacing: 10
                Text { width: parent.width; wrapMode: Text.Wrap; text: w.open ? w.open.subject : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 21; font.weight: Font.DemiBold }
                Row {
                    spacing: 10
                    Rectangle { width: 38; height: 38; radius: 19; color: Theme.alpha(Theme.accent, 0.25)
                        Text { anchors.centerIn: parent; text: w.open ? (w.open.from.name || "?").charAt(0).toUpperCase() : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold } }
                    Column { anchors.verticalCenter: parent.verticalCenter
                        Text { text: w.open ? w.open.from.name + "  ·  " + w.open.from.email : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                        Text { text: w.open ? Qt.formatDateTime(new Date(w.open.date), "dddd d 'de' MMMM, HH:mm") : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 } }
                }
                Row {
                    spacing: 8
                    Btn { label: "Responder"; primary: true; enabled: w.open !== null && w.open.text !== undefined; onClicked: w.compose(w.open) }
                    Btn { label: "Borrar"; tint: Theme.danger; enabled: w.open !== null; onClicked: w.remove(w.open) }
                }
                Rectangle { width: parent.width; height: 1; color: Theme.border }
                Repeater {
                    model: w.open && w.open.attachments ? w.open.attachments : []
                    Text { required property var modelData; text: "📎 " + modelData.name + "  (" + Math.max(1, Math.round(modelData.size / 1024)) + " KB)"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                }
                TextEdit {
                    width: parent.width; wrapMode: TextEdit.Wrap; readOnly: true; selectByMouse: true; textFormat: TextEdit.PlainText
                    text: w.reading ? "Abriendo…" : w.open && w.open.text !== undefined ? (w.open.text || "(mensaje sin texto)") : ""
                    color: Theme.text; selectionColor: Theme.alpha(Theme.accent, 0.45); font.family: Theme.font; font.pixelSize: 14
                }
            }
        }
    }

    // ---------------- write
    Rectangle {
        visible: w.composing
        anchors.fill: parent; color: Theme.alpha(Theme.bg, 0.72)
        MouseArea { anchors.fill: parent; hoverEnabled: true; onWheel: function(wheel) { wheel.accepted = true } }
        Rectangle {
            anchors.centerIn: parent; width: Math.min(parent.width - 60, 720); height: Math.min(parent.height - 60, 620); radius: 20
            color: Theme.card; border.color: Theme.border
            Column {
                anchors.fill: parent; anchors.margins: 20; spacing: 10
                Text { text: w.replyTo ? "Responder" : "Mensaje nuevo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold }
                Field { id: toField; width: parent.width; placeholderText: "Para (separa varias direcciones con comas)" }
                Field { id: subjField; width: parent.width; placeholderText: "Asunto" }
                Row {
                    visible: w.replyTo !== null; width: parent.width; spacing: 8
                    Field { id: hintField; width: parent.width - aiBtn.width - 8; placeholderText: "Dile a NEXUS AI qué responder (opcional): «di que sí, el jueves»" ; onAccepted: w.draftWithAi() }
                    Btn { id: aiBtn; height: 38; label: w.drafting ? "Escribiendo…" : "✦ Borrador con IA"; enabled: !w.drafting; onClicked: w.draftWithAi() }
                }
                Rectangle {
                    width: parent.width; height: parent.height - y - 54; radius: 12; color: Theme.card2; border.color: bodyArea.activeFocus ? Theme.accent : Theme.border
                    Flickable {
                        id: bodyFlick
                        anchors.fill: parent; anchors.margins: 10; clip: true
                        contentWidth: width; contentHeight: bodyArea.implicitHeight
                        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                        TextArea.flickable: TextArea { id: bodyArea; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; placeholderText: "Escribe tu mensaje"; placeholderTextColor: Theme.faint; background: null; selectByMouse: true }
                    }
                }
                Row {
                    spacing: 10
                    Btn { label: w.sending ? "Enviando…" : "Enviar"; primary: true; enabled: !w.sending && toField.text.trim() !== ""; onClicked: w.send() }
                    Btn { label: "Descartar"; tint: Theme.dark ? "#c9cfee" : "#3b4468"; enabled: !w.sending; onClicked: w.composing = false }
                    Text { visible: w.sendMsg !== ""; anchors.verticalCenter: parent.verticalCenter; text: w.sendMsg; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
                }
            }
        }
    }

    // ---------------- add an account
    Rectangle {
        visible: w.setup
        anchors.fill: parent; color: Theme.alpha(Theme.bg, w.acc ? 0.72 : 1)
        MouseArea { anchors.fill: parent; hoverEnabled: true; onWheel: function(wheel) { wheel.accepted = true } }
        Rectangle {
            anchors.centerIn: parent; width: Math.min(parent.width - 60, 520); height: setupCol.height + 44; radius: 20
            color: Theme.card; border.color: Theme.border
            Column {
                id: setupCol
                x: 22; y: 22; width: parent.width - 44; spacing: 10
                Row { spacing: 10
                    AppIcon { app: "mail"; width: 34; height: 34 }
                    Text { text: "Añade tu correo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 19; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter } }
                Row {
                    spacing: 8
                    Repeater {
                        model: w.info ? w.info.presets : []
                        Rectangle {
                            required property var modelData
                            readonly property bool on: w.kind === modelData.id
                            width: kt.implicitWidth + 26; height: 32; radius: 16
                            color: on ? Theme.accent : Theme.card2
                            Text { id: kt; anchors.centerIn: parent; text: modelData.name; color: parent.on ? "#ffffff" : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { w.kind = modelData.id; w.setupMsg = "" } }
                        }
                    }
                }
                Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2; text: w.preset ? w.preset.help : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                Field { id: nameField; width: parent.width; placeholderText: "Tu nombre (como lo verán)"; text: Session.me.name || "" }
                Field { id: emailField; width: parent.width; placeholderText: "Tu dirección de correo" }
                Field { id: passField; width: parent.width; placeholderText: "Contraseña de app (no la normal)"; echoMode: TextInput.Password; onAccepted: w.addAccount() }
                Field { id: imapField; visible: w.preset !== null && w.preset.custom === true; width: parent.width; placeholderText: "Servidor IMAP (imap.ejemplo.com, puerto 993)" }
                Field { id: smtpField; visible: w.preset !== null && w.preset.custom === true; width: parent.width; placeholderText: "Servidor SMTP (smtp.ejemplo.com, puerto 587)" }
                Text { visible: w.setupMsg !== ""; width: parent.width; wrapMode: Text.Wrap; text: w.setupMsg; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
                Row {
                    spacing: 10
                    Btn { label: w.setupBusy ? "Comprobando…" : "Comprobar y añadir"; primary: true; enabled: !w.setupBusy && emailField.text.trim() !== "" && passField.text.trim() !== ""; onClicked: w.addAccount() }
                    Btn { label: "Cancelar"; visible: w.acc !== null; tint: Theme.dark ? "#c9cfee" : "#3b4468"; onClicked: w.setup = false }
                }
                Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                    text: "NEXUS entra una vez para comprobarla. La contraseña se guarda solo en este equipo y solo viaja, cifrada, al servidor de tu correo. Outlook y Hotmail todavía no se pueden añadir."
                    color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
            }
        }
    }
}
