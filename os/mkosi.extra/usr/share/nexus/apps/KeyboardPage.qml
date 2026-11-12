import QtQuick
import "../shell"

// Ajustes → Teclado e idioma: the keyboard layout (and, for now, the interface language, which is Spanish).
Item {
    id: page
    property var kb: null
    property string err: ""
    property string note: ""
    function load() { Session.request("GET", "/keyboard", null, function(s, j) { if (s === 200 && j) page.kb = j }) }
    function set(id) { Session.request("POST", "/keyboard", { layout: id }, function(s, j) { if (s === 200 && j) { page.kb = j; page.err = ""; page.note = "Listo. Las ventanas nuevas ya usan esta distribución; para todo, cierra la sesión y vuelve a entrar." } else page.err = j && j.error ? j.error : "No se ha podido cambiar." }) }
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: "Teclado e idioma"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            Text { visible: page.note !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.note; color: Theme.good; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                title: "Distribución del teclado"
                note: "Qué teclado físico tienes: decide dónde están la ñ, los acentos y los símbolos."
                Repeater {
                    model: page.kb ? page.kb.layouts : []
                    Item {
                        required property var modelData
                        readonly property bool on: page.kb && page.kb.layout === modelData.id
                        width: parent.width; height: 38
                        Rectangle { anchors.fill: parent; radius: 10; color: on ? Theme.alpha(Theme.accent, 0.12) : kma.containsMouse ? Theme.hover : "transparent"; border.color: on ? Theme.alpha(Theme.accent, 0.5) : "transparent" }
                        Rectangle { x: 10; anchors.verticalCenter: parent.verticalCenter; width: 10; height: 10; radius: 5; color: on ? Theme.accent : "transparent"; border.color: on ? Theme.accent : Theme.dim }
                        Text { x: 32; anchors.verticalCenter: parent.verticalCenter; text: modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: on ? Font.DemiBold : Font.Normal }
                        Text { anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter; text: modelData.id; color: Theme.faint; font.family: Theme.mono; font.pixelSize: 12 }
                        MouseArea { id: kma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.set(modelData.id) }
                    }
                }
            }
            SettingsCard {
                title: "Idioma de NEXUS"
                note: "Por ahora NEXUS habla español. El inglés y otros idiomas están en camino."
                Rectangle { width: it.implicitWidth + 22; height: 32; radius: 9; color: Theme.alpha(Theme.accent, 0.2); border.color: Theme.accent; Text { id: it; anchors.centerIn: parent; text: "Español"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 } }
            }
        }
    }
}
