import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// The welcome tour: the first time a person sits at this NEXUS (pref `welcomed`), and from Ayuda → Recorrido de
// bienvenida whenever they want. Eight short cards: what NEXUS is, the launcher, windows and desktops, notices,
// NEXUS AI and its key, the terminal, the agents, Ajustes and security. Nothing is required: Saltar leaves at once.
Window {
    id: wl
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-welcome"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property bool shown: false
    property int step: 0
    function open() { hideLater.stop(); step = 0; visible = true; shown = true; requestActivate(); keys.forceActiveFocus() }
    function close() { if (!shown) return; shown = false; hideLater.restart(); Session.setPref("welcomed", true) }
    function next() { if (step < steps.length - 1) step++; else close() }
    function back() { if (step > 0) step-- }
    Timer { id: hideLater; interval: Theme.ms(220) + 10; onTriggered: if (!wl.shown) wl.visible = false }

    readonly property var steps: [
        { icon: "sparkle", title: "Bienvenido a NEXUS OS", text: "Un sistema pensado para que la inteligencia artificial trabaje contigo sin poder hacer daño: cada agente va aislado y nada importante pasa sin tu clic. Este recorrido dura un minuto; puedes saltarlo y volver desde Ayuda.", key: "" },
        { icon: "search", title: "Todo desde una caja", text: "Pulsa Súper + Espacio y escribe: apps, archivos, páginas de Ajustes, una búsqueda en la web o una pregunta para NEXUS AI. Las flechas recorren los resultados y ↵ abre.", key: "Súper + Espacio" },
        { icon: "layers", title: "Ventanas y escritorios", text: "Súper + Tab enseña todas tus ventanas y cuatro escritorios. Súper + 1…4 cambia de escritorio; Súper + Mayús + 1…4 manda allí la ventana activa; el botón junto a la pantera hace lo mismo.", key: "Súper + Tab" },
        { icon: "bell", title: "Los avisos no se pierden", text: "La campana de la barra guarda cada aviso: actualizaciones, correo de tus contactos importantes, agentes que esperan tu permiso. Súper + N lo abre; No molestar los deja ahí sin molestar.", key: "Súper + N" },
        { icon: "brain", title: "NEXUS AI", text: "Habla con el equipo: «organiza mis fotos por año», «abre la terminal», «¿cuánta memoria tengo?». Para preguntas abiertas hace falta una clave de Claude: se pega en Ajustes → NEXUS AI y se queda en este equipo.", key: "Ajustes → NEXUS AI", action: "ai" },
        { icon: "terminal", title: "La terminal, lista para todo", text: "Pestañas, paneles y sugerencias del historial. Trae node, python, git, gh, cmake… Escribe «ai ¿cómo deshago el último commit?» o canaliza cualquier salida: «npm test 2>&1 | ai por qué falla».", key: "Súper + Intro" },
        { icon: "agents", title: "Agentes que no pueden romper nada", text: "Un agente de IA trabaja en su carpeta, sin tus llaves y sin red abierta. Cada orden con riesgo (git push, borrar, instalar) espera tu aprobación en una ventana. Fuera de NEXUS, «nexus-agent -- claude» hace lo mismo.", key: "Agentes" },
        { icon: "shield", title: "Ajustes y seguridad", text: "Ajustes reúne Wi-Fi, Bluetooth, sonido, pantalla, teclado y tu cuenta con su foto. Privacidad y seguridad puntúa el equipo y arregla con un clic lo que falte: cortafuegos, bloqueo, contraseña.", key: "Ajustes", action: "seguridad" }
    ]
    readonly property var cur: steps[step]

    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0.02, 0.03, 0.06, Theme.dark ? 0.78 : 0.55)
        opacity: wl.shown ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.ms(wl.shown ? 220 : 180); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent }
    }
    Item {
        id: keys
        anchors.fill: parent
        focus: true
        Keys.onEscapePressed: wl.close()
        Keys.onRightPressed: wl.next()
        Keys.onReturnPressed: wl.next()
        Keys.onEnterPressed: wl.next()
        Keys.onSpacePressed: wl.next()
        Keys.onLeftPressed: wl.back()
    }

    Rectangle {
        id: card
        width: Math.min(640, wl.width - 60)
        height: body.y + body.height + 92
        anchors.centerIn: parent
        radius: 24
        color: Theme.dark ? Qt.rgba(0.08, 0.085, 0.15, 0.985) : Theme.card
        border.color: Theme.alpha(Theme.accent, 0.45)
        opacity: wl.shown ? 1 : 0
        scale: wl.shown ? 1 : 0.94
        Behavior on opacity { NumberAnimation { duration: Theme.ms(240); easing.type: Easing.OutCubic } }
        Behavior on scale { NumberAnimation { duration: Theme.ms(300); easing.type: Easing.OutCubic } }
        Behavior on height { NumberAnimation { duration: Theme.ms(200); easing.type: Easing.OutCubic } }

        // the panther on the first card, the step's icon on the others
        Image { visible: wl.step === 0; x: 34; y: 30; width: 72; height: 72; source: Qt.resolvedUrl("../icons/pantera-logo.png"); sourceSize: Qt.size(144, 144) }
        Rectangle {
            visible: wl.step > 0
            x: 34; y: 30; width: 72; height: 72; radius: 20
            color: Theme.alpha(Theme.accent, 0.18)
            LineIcon { anchors.centerIn: parent; name: wl.cur.icon; size: 36; stroke: 1.5; color: Theme.accent }
        }
        Rectangle {
            visible: wl.cur.key !== ""
            anchors.right: parent.right; anchors.rightMargin: 30; y: 36
            width: keyT.implicitWidth + 22; height: 30; radius: 8
            color: Theme.hover; border.color: Theme.border
            Text { id: keyT; anchors.centerIn: parent; text: wl.cur.key; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
        }
        Text {
            id: ttl
            x: 34; y: 124; width: parent.width - 68
            text: wl.cur.title
            color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold
            wrapMode: Text.Wrap
        }
        Text {
            id: body
            x: 34; y: ttl.y + ttl.height + 12; width: parent.width - 68
            text: wl.cur.text
            color: Theme.dim; font.family: Theme.font; font.pixelSize: 15; lineHeight: 1.3
            wrapMode: Text.Wrap
        }
        // the dots
        Row {
            x: 34; y: parent.height - 50
            spacing: 7
            Repeater {
                model: wl.steps.length
                Rectangle {
                    required property int index
                    width: index === wl.step ? 22 : 8; height: 8; radius: 4
                    color: index === wl.step ? Theme.accent : Theme.alpha(Theme.text, 0.2)
                    Behavior on width { NumberAnimation { duration: Theme.ms(200); easing.type: Easing.OutCubic } }
                    MouseArea { anchors.fill: parent; anchors.margins: -4; cursorShape: Qt.PointingHandCursor; onClicked: wl.step = index }
                }
            }
        }
        Row {
            anchors.right: parent.right; anchors.rightMargin: 30; y: parent.height - 62
            spacing: 10
            Btn { visible: wl.cur.action === "ai"; label: "Poner la clave"; onClicked: { Session.openSettings("ai"); wl.close() } }
            Btn { visible: wl.cur.action === "seguridad"; label: "Ver la seguridad"; onClicked: { Session.openSettings("seguridad"); wl.close() } }
            Btn { visible: wl.step < wl.steps.length - 1; label: "Saltar"; onClicked: wl.close() }
            Btn { visible: wl.step > 0; label: "Atrás"; onClicked: wl.back() }
            Btn { primary: true; label: wl.step < wl.steps.length - 1 ? "Siguiente" : "Empezar"; onClicked: wl.next() }
        }
    }
    component Btn: Rectangle {
        id: b
        property string label: ""
        property bool primary: false
        signal clicked()
        width: bt.implicitWidth + 32; height: 40; radius: 20
        color: primary ? (bma.containsMouse ? Qt.lighter(Theme.accent, 1.08) : Theme.accent) : bma.containsMouse ? Theme.hover : "transparent"
        border.color: primary ? "transparent" : Theme.border
        Text { id: bt; anchors.centerIn: parent; text: b.label; color: b.primary ? "#ffffff" : Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
        MouseArea { id: bma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: b.clicked() }
    }
}
