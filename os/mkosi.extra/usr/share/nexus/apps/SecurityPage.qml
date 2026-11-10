import QtQuick
import QtQuick.Controls
import QtQuick.Shapes
import "../shell"

// Ajustes → Privacidad y seguridad: the checkup of this computer (GET /security of nexus-sessiond, which asks the
// root service nexus-guardd) as a score ring, what to improve with one-click fixes, the protections as switches and
// the privacy choices. Turning a protection OFF asks for the account's password (the guard checks it, not this page);
// turning it on never does.
Item {
    id: page
    property var sec: null
    property bool loading: false
    property string err: ""
    property var pending: null          // { label, body }: a change waiting for the password
    property string promptErr: ""
    property bool promptBusy: false
    property bool pwOpen: false         // the "change password" form
    property string pwMsg: ""
    property bool pwErr: false
    property bool pwBusy: false
    signal openPage(string section)

    readonly property color gradeColor: !sec ? Theme.faint : sec.grade === "protegido" ? Theme.good : sec.grade === "mejorable" ? Theme.warn : Theme.danger
    readonly property var todo: sec ? sec.items.filter(function(i) { return i.level === "bad" || i.level === "warn" }) : []
    readonly property var fine: sec ? sec.items.filter(function(i) { return i.level === "ok" || i.level === "info" }) : []
    readonly property var root: sec && sec.root ? sec.root : null
    readonly property var icons: ({ firewall: "wall", password: "key", remote: "terminal", sudo: "lock", login: "power", kernel: "gear", lock: "clock",
                                    sandbox: "agents", updates: "update", exposed: "broadcast", guard: "shield" })

    function load() {
        loading = true
        Session.request("GET", "/security", null, function(st, j) {
            page.loading = false
            if (st === 200 && j) { page.sec = j; page.err = "" } else page.err = "No se ha podido comprobar la seguridad ahora mismo."
        })
    }
    function send(body) {   // a change that makes the computer safer: no password
        Session.request("POST", "/security", body, function(st, j) {
            if (st === 200 && j) { page.sec = j; page.err = "" } else page.err = j && j.error ? j.error : "No se ha podido hacer el cambio."
        })
    }
    function ask(label, body) { promptErr = ""; pending = { label: label, body: body }; promptField.text = ""; promptField.forceActiveFocus() }
    function confirmPrompt() {
        if (!pending || promptBusy || promptField.text === "") return
        var b = JSON.parse(JSON.stringify(pending.body)); b.password = promptField.text
        promptBusy = true
        Session.request("POST", "/security", b, function(st, j) {
            page.promptBusy = false
            promptField.text = ""
            if (st === 200 && j) { page.sec = j; page.pending = null }
            else { page.promptErr = j && j.error ? j.error : "No se ha podido hacer el cambio."; shake.restart(); promptField.forceActiveFocus() }
        })
    }
    function fix(action) {
        if (action === "firewall") send({ action: "firewall" })
        else if (action === "remote-off") send({ action: "remote", on: false })
        else if (action === "sudo-ask") send({ action: "sudo", ask: true })
        else if (action === "login-ask") send({ action: "login", ask: true })
        else if (action === "lock-5") Session.setPref("lockAfter", 5)
        else if (action === "password") { pwOpen = true; pwMsg = ""; flick.contentY = Math.max(0, Math.min(flick.contentHeight - flick.height, protections.y + pwRow.y - 20)); curField.forceActiveFocus() }
        else if (action === "updates") openPage("actualizaciones")
    }
    function changePassword() {
        if (pwBusy) return
        if (newField.text !== repField.text) { pwErr = true; pwMsg = "Las dos contraseñas nuevas no coinciden."; return }
        pwBusy = true
        Session.request("POST", "/security", { action: "password", current: curField.text, next: newField.text }, function(st, j) {
            page.pwBusy = false
            if (st === 200 && j) { page.sec = j; page.pwErr = false; page.pwMsg = "Contraseña cambiada."; curField.text = ""; newField.text = ""; repField.text = ""; page.pwOpen = false }
            else { page.pwErr = true; page.pwMsg = j && j.error ? j.error : "No se ha podido cambiar la contraseña."; if (st === 403 || st === 429) { curField.text = ""; curField.forceActiveFocus() } }
        })
    }
    // how good a new password looks while it is typed: 0..4 (the guard has the last word)
    function strength(p) {
        if (!p) return 0
        var kinds = (/[a-z]/.test(p) ? 1 : 0) + (/[A-Z]/.test(p) ? 1 : 0) + (/[0-9]/.test(p) ? 1 : 0) + (/[^A-Za-z0-9]/.test(p) ? 1 : 0)
        if (p.length < 8) return 1
        if (p.length >= 16 || (p.length >= 12 && kinds >= 3)) return 4
        if (p.length >= 12 || kinds >= 3) return 3
        return 2
    }
    function lockLabel(m) { return m === 0 ? "Nunca" : m === 60 ? "1 h" : m + " min" }

    onVisibleChanged: if (visible) load()
    Component.onCompleted: if (visible) load()
    Connections { target: Session; function onSecurityChanged() { if (page.visible) page.load() } }
    onSecChanged: if (sec && Theme.motion) haloAnim.restart()

    // ---- building blocks
    component Chip: Rectangle {
        property string icon: "shield"
        property color tint: Theme.accent
        width: 34; height: 34; radius: 10
        color: Theme.alpha(tint, 0.16)
        LineIcon { anchors.centerIn: parent; name: parent.icon; color: parent.tint; size: 19 }
    }
    component Toggle: Item {
        id: tg
        property bool on: false
        property bool busy: false
        signal clicked()
        width: 46; height: 28
        opacity: enabled ? 1 : 0.45
        Rectangle {
            anchors.fill: parent; radius: height / 2
            color: tg.on ? Theme.good : Theme.alpha(Theme.text, 0.18)
            Behavior on color { ColorAnimation { duration: Theme.ms(160) } }
            Rectangle {
                width: 22; height: 22; radius: 11; y: 3
                x: tg.on ? parent.width - width - 3 : 3
                color: "#ffffff"
                Behavior on x { NumberAnimation { duration: Theme.ms(180); easing.type: Easing.OutCubic } }
            }
        }
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: tg.clicked() }
    }
    component Btn: Rectangle {
        id: bt
        property string label: ""
        property bool primary: false
        property color tint: Theme.accent
        signal clicked()
        width: btText.implicitWidth + 28; height: 34; radius: 10
        opacity: enabled ? 1 : 0.5
        color: primary ? (btArea.pressed ? Qt.darker(tint, 1.2) : tint) : btArea.containsMouse ? Theme.alpha(tint, 0.16) : Theme.alpha(tint, 0.10)
        Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
        Text { id: btText; anchors.centerIn: parent; text: bt.label; color: bt.primary ? "#ffffff" : bt.tint; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
        MouseArea { id: btArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bt.clicked() }
    }
    component Group: Rectangle {
        default property alias rows: groupCol.data
        width: parent ? parent.width : 0
        height: groupCol.height
        radius: 16; color: Theme.card; border.color: Theme.border
        Column { id: groupCol; width: parent.width }
    }
    // one line of a group: icon, title, explanation and, on the right, whatever the row holds
    component Line: Item {
        id: ln
        property string icon: "shield"
        property color tint: Theme.accent
        property string title: ""
        property string detail: ""
        property bool first: false
        default property alias control: ctl.data
        width: parent ? parent.width : 0
        height: Math.max(64, lnText.height + 26)
        Rectangle { visible: !ln.first; x: 62; width: parent.width - 62; height: 1; color: Theme.border }
        Chip { x: 16; anchors.verticalCenter: parent.verticalCenter; icon: ln.icon; tint: ln.tint }
        Column {
            id: lnText
            x: 62; width: parent.width - 62 - ctl.width - 30
            anchors.verticalCenter: parent.verticalCenter
            spacing: 2
            Text { width: parent.width; wrapMode: Text.Wrap; text: ln.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
            Text { width: parent.width; wrapMode: Text.Wrap; visible: text !== ""; text: ln.detail; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.15 }
        }
        Row { id: ctl; anchors.right: parent.right; anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter; spacing: 8 }
    }
    component Secret: TextField {
        id: sf
        echoMode: TextInput.Password
        color: Theme.text; placeholderTextColor: Theme.faint
        font.family: Theme.font; font.pixelSize: 14
        leftPadding: 14
        background: Rectangle { implicitHeight: 40; radius: 11; color: Theme.card2; border.color: sf.activeFocus ? Theme.accent : Theme.border; border.width: sf.activeFocus ? 2 : 1 }
    }
    component Heading: Text {
        color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
        font.capitalization: Font.AllUppercase; font.letterSpacing: 1; leftPadding: 4; topPadding: 6
    }

    Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width; contentHeight: col.height + 28
        clip: true; boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Behavior on contentY { NumberAnimation { duration: Theme.ms(260); easing.type: Easing.OutCubic } }

        Column {
            id: col
            width: Math.min(flick.width - 14, 700)
            spacing: 14
            Text { text: "Privacidad y seguridad"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }

            // ---------------- the score
            Rectangle {
                id: hero
                width: parent.width; height: 176; radius: 20
                border.color: Theme.alpha(page.gradeColor, 0.35)
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0; color: Theme.alpha(page.gradeColor, Theme.dark ? 0.20 : 0.16) }
                    GradientStop { position: 0.75; color: Theme.card }
                }
                Item {
                    id: ring
                    x: 24; anchors.verticalCenter: parent.verticalCenter
                    width: 132; height: 132
                    property real shown: page.sec ? page.sec.score : 0
                    Behavior on shown { NumberAnimation { duration: Theme.ms(900); easing.type: Easing.OutCubic } }
                    Rectangle {   // a ring of light that leaves the score when it changes
                        id: halo
                        anchors.centerIn: parent; width: 124; height: 124; radius: 62
                        color: "transparent"; border.color: page.gradeColor; border.width: 2; opacity: 0
                        ParallelAnimation {
                            id: haloAnim
                            loops: 2
                            NumberAnimation { target: halo; property: "scale"; from: 0.95; to: 1.28; duration: 1300; easing.type: Easing.OutCubic }
                            NumberAnimation { target: halo; property: "opacity"; from: 0.55; to: 0; duration: 1300; easing.type: Easing.OutQuad }
                        }
                    }
                    Shape {
                        anchors.fill: parent
                        preferredRendererType: Shape.CurveRenderer
                        ShapePath {
                            strokeColor: Theme.alpha(Theme.text, 0.09); strokeWidth: 10; fillColor: "transparent"
                            PathAngleArc { centerX: 66; centerY: 66; radiusX: 56; radiusY: 56; startAngle: 0; sweepAngle: 360 }
                        }
                        ShapePath {
                            strokeColor: page.gradeColor; strokeWidth: 10; fillColor: "transparent"; capStyle: ShapePath.RoundCap
                            PathAngleArc { centerX: 66; centerY: 66; radiusX: 56; radiusY: 56; startAngle: -90; sweepAngle: Math.max(0.01, 3.6 * ring.shown) }
                        }
                    }
                    Column {
                        anchors.centerIn: parent
                        Text { anchors.horizontalCenter: parent.horizontalCenter; text: page.sec ? Math.round(ring.shown) : "–"; color: Theme.text; font.family: Theme.font; font.pixelSize: 40; font.weight: Font.Bold }
                        Text { anchors.horizontalCenter: parent.horizontalCenter; text: "de 100"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
                    }
                }
                Column {
                    x: 180; width: parent.width - x - 22
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 6
                    Row {
                        spacing: 8
                        LineIcon { name: page.sec && page.sec.grade === "protegido" ? "shield-check" : "shield"; color: page.gradeColor; size: 20; anchors.verticalCenter: parent.verticalCenter }
                        Text {
                            text: !page.sec ? "Comprobando…" : page.sec.grade === "protegido" ? "Protegido" : page.sec.grade === "mejorable" ? "Mejorable" : "En riesgo"
                            color: page.gradeColor; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold; font.capitalization: Font.AllUppercase; font.letterSpacing: 1
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }
                    Text { width: parent.width; wrapMode: Text.Wrap; text: page.sec ? page.sec.headline : "Mirando el cortafuegos, las contraseñas y el bloqueo…"; color: Theme.text; font.family: Theme.font; font.pixelSize: 21; font.weight: Font.DemiBold }
                    Text {
                        width: parent.width; wrapMode: Text.Wrap
                        text: page.err !== "" ? page.err : page.sec ? page.sec.items.length + " comprobaciones · " + page.fine.filter(function(i) { return i.level === "ok" }).length + " en orden" : ""
                        color: page.err !== "" ? Theme.danger : Theme.dim; font.family: Theme.font; font.pixelSize: 13
                    }
                    Item { width: 1; height: 2 }
                    Btn { label: page.loading ? "Comprobando…" : "Volver a comprobar"; tint: Theme.dark ? "#c9cfee" : "#3b4468"; enabled: !page.loading; onClicked: page.load() }
                }
            }

            // ---------------- what to improve
            Heading { visible: page.todo.length > 0; text: "Qué mejorar" }
            Group {
                visible: page.todo.length > 0
                Repeater {
                    model: page.todo
                    Line {
                        required property var modelData
                        required property int index
                        first: index === 0
                        icon: page.icons[modelData.id] || "shield"
                        tint: modelData.level === "bad" ? Theme.danger : Theme.warn
                        title: modelData.title; detail: modelData.detail
                        Btn { visible: !!modelData.fix; label: modelData.fix ? modelData.fix.label : ""; primary: true; tint: modelData.level === "bad" ? Theme.danger : Theme.accent; onClicked: page.fix(modelData.fix.action) }
                    }
                }
            }

            // ---------------- the protections
            Heading { text: "Protecciones" }
            Group {
                id: protections
                opacity: page.root ? 1 : 0.5
                enabled: page.root !== null
                Line {
                    first: true
                    icon: "wall"; tint: page.root && page.root.firewall === "on" ? Theme.good : Theme.danger
                    title: "Cortafuegos"
                    detail: "Bloquea todo lo que intente entrar desde la red. Lo que tú abres hacia fuera no se toca."
                    Rectangle {
                        readonly property bool on: page.root !== null && page.root.firewall === "on"
                        width: fwText.implicitWidth + 22; height: 26; radius: 13
                        color: Theme.alpha(on ? Theme.good : Theme.danger, 0.16)
                        Text { id: fwText; anchors.centerIn: parent; text: !page.root ? "–" : parent.on ? "Activado" : page.root.firewall === "off" ? "Apagado" : "No instalado"; color: parent.on ? Theme.good : Theme.danger; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                    }
                }
                Line {
                    icon: "terminal"; tint: "#5c9dff"
                    title: "Acceso remoto (SSH)"
                    detail: "Permite entrar en este equipo desde otro con una llave autorizada. El cortafuegos abre su puerta solo mientras está activado."
                    Toggle {
                        on: page.root !== null && page.root.remote
                        onClicked: on ? page.send({ action: "remote", on: false }) : page.ask("activar el acceso remoto", { action: "remote", on: true })
                    }
                }
                Line {
                    icon: "lock"; tint: "#b46cff"
                    title: "Pedir la contraseña para administrar"
                    detail: "Cambiar el sistema (sudo) pide tu contraseña, así ningún programa se hace administrador por su cuenta."
                    Toggle {
                        on: page.root !== null && !page.root.sudoNoPassword
                        onClicked: on ? page.ask("dejar de pedir la contraseña para administrar", { action: "sudo", ask: false }) : page.send({ action: "sudo", ask: true })
                    }
                }
                Line {
                    icon: "power"; tint: "#ff9f43"
                    title: "Pedir la contraseña al encender"
                    detail: "Al encender el equipo aparece la pantalla de inicio de sesión en vez de tu escritorio."
                    Toggle {
                        on: page.root !== null && page.root.loginPassword
                        onClicked: on ? page.ask("entrar sin contraseña al encender", { action: "login", ask: false }) : page.send({ action: "login", ask: true })
                    }
                }
                Item {   // the automatic lock: the minutes as a row of choices
                    width: parent.width; height: 96
                    enabled: page.sec !== null && page.sec.idleAvailable === true
                    opacity: enabled ? 1 : 0.5
                    Rectangle { x: 62; width: parent.width - 62; height: 1; color: Theme.border }
                    Chip { x: 16; y: 15; icon: "clock"; tint: "#38d9ff" }
                    Text { x: 62; y: 14; text: "Bloqueo automático"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                    Text { x: 62; y: 34; width: parent.width - 80; elide: Text.ElideRight; text: "La pantalla se bloquea sola si dejas el equipo quieto, y siempre al suspender."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    Row {
                        x: 62; y: 58; spacing: 6
                        Repeater {
                            model: page.sec ? page.sec.lockChoices : []
                            Rectangle {
                                required property var modelData
                                readonly property bool on: page.sec !== null && page.sec.lockAfter === modelData
                                width: lkText.implicitWidth + 20; height: 26; radius: 13
                                color: on ? Theme.accent : lkArea.containsMouse ? Theme.hover : Theme.card2
                                Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                                Text { id: lkText; anchors.centerIn: parent; text: page.lockLabel(modelData); color: parent.on ? "#ffffff" : Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: parent.on ? Font.DemiBold : Font.Normal }
                                MouseArea { id: lkArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("lockAfter", modelData) }
                            }
                        }
                    }
                }
                Item {   // the password, and the form to change it
                    id: pwRow
                    width: parent.width
                    height: 64 + (page.pwOpen ? pwForm.height + 14 : 0)
                    clip: true
                    Behavior on height { NumberAnimation { duration: Theme.ms(220); easing.type: Easing.OutCubic } }
                    Rectangle { x: 62; width: parent.width - 62; height: 1; color: Theme.border }
                    Chip { x: 16; y: 15; icon: "key"; tint: page.root && page.root.defaultPassword === true ? Theme.danger : Theme.good }
                    Text { x: 62; y: 14; text: "Contraseña de " + (page.sec ? page.sec.user : "la cuenta"); color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                    Text {
                        x: 62; y: 34; width: parent.width - 200; elide: Text.ElideRight
                        text: page.pwMsg !== "" && !page.pwOpen ? page.pwMsg : page.root && page.root.defaultPassword === true ? "Sigue siendo la de fábrica: cámbiala." : "Desbloquea la pantalla y autoriza los cambios de esta página."
                        color: page.pwMsg !== "" && !page.pwOpen ? Theme.good : page.root && page.root.defaultPassword === true ? Theme.danger : Theme.dim
                        font.family: Theme.font; font.pixelSize: 12
                    }
                    Btn { anchors.right: parent.right; anchors.rightMargin: 16; y: 15; label: page.pwOpen ? "Cancelar" : "Cambiar…"; onClicked: { page.pwOpen = !page.pwOpen; page.pwMsg = ""; if (page.pwOpen) curField.forceActiveFocus() } }
                    Column {
                        id: pwForm
                        x: 62; y: 66; width: Math.min(parent.width - 78, 380)
                        spacing: 8
                        visible: page.pwOpen
                        Secret { id: curField; width: parent.width; placeholderText: "Contraseña de ahora"; onAccepted: newField.forceActiveFocus() }
                        Secret { id: newField; width: parent.width; placeholderText: "Contraseña nueva (8 caracteres o más)"; onAccepted: repField.forceActiveFocus() }
                        Row {   // how strong the new one looks
                            spacing: 4
                            readonly property int level: page.strength(newField.text)
                            Repeater {
                                model: 4
                                Rectangle {
                                    required property int index
                                    width: 44; height: 4; radius: 2
                                    color: index < parent.level ? (parent.level <= 1 ? Theme.danger : parent.level === 2 ? Theme.warn : Theme.good) : Theme.alpha(Theme.text, 0.12)
                                    Behavior on color { ColorAnimation { duration: Theme.ms(160) } }
                                }
                            }
                            Text { leftPadding: 6; y: -6; text: ["", "Muy corta", "Justa", "Buena", "Muy buena"][parent.level]; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                        }
                        Secret { id: repField; width: parent.width; placeholderText: "Repite la contraseña nueva"; onAccepted: page.changePassword() }
                        Text { visible: page.pwMsg !== "" && page.pwOpen; width: parent.width; wrapMode: Text.Wrap; text: page.pwMsg; color: page.pwErr ? Theme.danger : Theme.good; font.family: Theme.font; font.pixelSize: 12 }
                        Btn { label: page.pwBusy ? "Cambiando…" : "Cambiar la contraseña"; primary: true; enabled: !page.pwBusy && curField.text !== "" && newField.text.length >= 8 && repField.text !== ""; onClicked: page.changePassword() }
                    }
                }
            }
            Text {
                visible: page.sec !== null && !page.root
                width: parent.width; wrapMode: Text.Wrap; leftPadding: 4
                text: "El guardián de NEXUS no responde, así que estas protecciones no se pueden cambiar ahora mismo."
                color: Theme.warn; font.family: Theme.font; font.pixelSize: 12
            }

            // ---------------- privacy
            Heading { text: "Privacidad" }
            Group {
                Line {
                    first: true
                    icon: "search"; tint: "#38d9ff"
                    title: "Recordar las páginas que visito"
                    detail: "NEXUS Search las sugiere al escribir. Se guardan solo en este equipo."
                    Toggle { on: Session.prefs.searchMemory !== false; onClicked: Session.setPref("searchMemory", !on) }
                }
                Line {
                    icon: "trash"; tint: Theme.danger
                    title: "Historial de NEXUS Search"
                    detail: !page.sec ? "" : page.sec.remembered === 0 ? "No hay páginas recordadas." : page.sec.remembered === 1 ? "1 página recordada." : page.sec.remembered + " páginas recordadas."
                    Btn { label: "Borrar"; tint: Theme.danger; enabled: page.sec !== null && page.sec.remembered > 0; onClicked: Session.request("POST", "/search/clear", {}, function() { page.load() }) }
                }
                Line {
                    icon: "sparkle"; tint: "#b46cff"
                    title: "Clave de NEXUS AI"
                    detail: Session.aiConfigured ? "Guardada solo en este equipo; únicamente el motor de NEXUS puede leerla, ni las apps ni los agentes." : "No hay ninguna clave guardada."
                    Btn { label: "Gestionar"; onClicked: page.openPage("ai") }
                }
            }

            // ---------------- what is fine
            Heading { visible: page.fine.length > 0; text: "En orden" }
            Group {
                visible: page.fine.length > 0
                Repeater {
                    model: page.fine
                    Line {
                        required property var modelData
                        required property int index
                        first: index === 0
                        icon: page.icons[modelData.id] || "shield"
                        tint: modelData.level === "ok" ? Theme.good : Theme.dim
                        title: modelData.title; detail: modelData.detail
                        LineIcon { visible: modelData.level === "ok"; name: "check"; color: Theme.good; size: 18; stroke: 2.2 }
                    }
                }
            }
            Item { width: 1; height: 4 }
        }
    }

    // ---------------- the password, before a change that makes the computer less safe
    Rectangle {
        id: veil
        anchors.fill: parent; anchors.margins: -28
        visible: opacity > 0
        opacity: page.pending ? 1 : 0
        color: Theme.alpha(Theme.bg, 0.72)
        Behavior on opacity { NumberAnimation { duration: Theme.ms(160) } }
        onVisibleChanged: if (visible) promptField.forceActiveFocus()
        MouseArea { anchors.fill: parent; hoverEnabled: true; onClicked: if (!page.promptBusy) page.pending = null; onWheel: function(wheel) { wheel.accepted = true } }
        Rectangle {
            id: sheet
            width: Math.min(parent.width - 60, 400); height: sheetCol.height + 44; radius: 20
            anchors.centerIn: parent
            color: Theme.card; border.color: Theme.border
            scale: page.pending ? 1 : 0.94
            Behavior on scale { NumberAnimation { duration: Theme.ms(200); easing.type: Easing.OutBack } }
            transform: Translate { id: sheetShift }
            SequentialAnimation {   // a wrong password shakes the sheet
                id: shake
                NumberAnimation { target: sheetShift; property: "x"; to: -10; duration: 50 }
                NumberAnimation { target: sheetShift; property: "x"; to: 10; duration: 70 }
                NumberAnimation { target: sheetShift; property: "x"; to: -6; duration: 60 }
                NumberAnimation { target: sheetShift; property: "x"; to: 0; duration: 60 }
            }
            MouseArea { anchors.fill: parent }   // clicks inside do not close it
            Column {
                id: sheetCol
                x: 24; y: 22; width: parent.width - 48
                spacing: 12
                Chip { anchors.horizontalCenter: parent.horizontalCenter; width: 48; height: 48; radius: 14; icon: "lock"; tint: Theme.accent }
                Text { width: parent.width; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap; text: "Escribe tu contraseña"; color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold }
                Text { width: parent.width; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap; text: page.pending ? "NEXUS la pide para " + page.pending.label + ", porque deja el equipo menos protegido." : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                Secret { id: promptField; width: parent.width; placeholderText: "Contraseña"; onAccepted: page.confirmPrompt(); Keys.onEscapePressed: if (!page.promptBusy) page.pending = null }
                Text { visible: page.promptErr !== ""; width: parent.width; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap; text: page.promptErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 12 }
                Row {
                    anchors.horizontalCenter: parent.horizontalCenter
                    spacing: 10
                    Btn { label: "Cancelar"; tint: Theme.dark ? "#c9cfee" : "#3b4468"; enabled: !page.promptBusy; onClicked: page.pending = null }
                    Btn { label: page.promptBusy ? "Comprobando…" : "Continuar"; primary: true; enabled: !page.promptBusy && promptField.text !== ""; onClicked: page.confirmPrompt() }
                }
            }
        }
    }
}
