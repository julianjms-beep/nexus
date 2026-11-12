import QtQuick
import "../shell"

// Ajustes → Cuenta: who uses this computer, their picture (chosen among their recent images), and where the
// password lives (Privacidad y seguridad).
Item {
    id: page
    property var recent: []
    property string err: ""
    signal openPage(string section)
    function load() {
        Session.refreshMe()
        Session.request("GET", "/files/recent", null, function(s, j) { if (s === 200 && j) page.recent = (j.entries || []).filter(function(e) { return /\.(png|jpe?g|webp)$/i.test(e.name) }).slice(0, 12) })
    }
    function pick(p) { Session.request("POST", "/me/photo", { path: p }, function(s, j) { page.err = s === 200 ? "" : (j && j.error ? j.error : "No se ha podido usar esa imagen."); Session.refreshMe() }) }
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: "Cuenta"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                Item {
                    width: parent.width; height: 96
                    Rectangle {
                        id: ring
                        y: 6; width: 84; height: 84; radius: 42
                        gradient: Gradient { GradientStop { position: 0; color: Theme.accent } GradientStop { position: 1; color: Theme.accent2 } }
                        Text { anchors.centerIn: parent; visible: !Session.me.photo; text: (Session.me.name || "?").charAt(0).toUpperCase(); color: "#ffffff"; font.family: Theme.font; font.pixelSize: 34; font.weight: Font.Bold }
                        Avatar { anchors.fill: parent; photo: Session.me.photo; stamp: Session.meStamp }
                    }
                    Column {
                        x: 104; y: 14
                        Text { text: Session.me.name || ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.DemiBold }
                        Text { text: "Usuario " + Session.me.user + " · administrador de este equipo"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                        Row {
                            topPadding: 8; spacing: 8
                            SettingsButton { label: "Cambiar la contraseña…"; onClicked: page.openPage("seguridad") }
                            SettingsButton { visible: !!Session.me.photo; label: "Quitar la foto"; danger: true; onClicked: page.pick("") }
                        }
                    }
                }
            }
            SettingsCard {
                title: "Tu foto"
                note: page.recent.length === 0 ? "No hay imágenes recientes en tu carpeta personal. Guarda una foto en Imágenes y vuelve aquí." : "Elige una de tus imágenes recientes. Se verá en Ajustes, en el menú de inicio y en la pantalla de bloqueo."
                Flow {
                    width: parent.width; spacing: 10
                    Repeater {
                        model: page.recent
                        Rectangle {
                            required property var modelData
                            width: 86; height: 86; radius: 14
                            color: Theme.card2; border.color: pma.containsMouse ? Theme.accent : Theme.border; clip: true
                            Image { anchors.fill: parent; anchors.margins: 3; source: "file://" + modelData.path; fillMode: Image.PreserveAspectCrop; sourceSize: Qt.size(172, 172); asynchronous: true }
                            MouseArea { id: pma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.pick(modelData.path) }
                        }
                    }
                }
            }
        }
    }
}
