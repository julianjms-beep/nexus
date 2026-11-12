import QtQuick
import "../shell"

// A small button of the settings pages.
Rectangle {
    id: b
    property string label: ""
    property bool primary: false
    property bool danger: false
    property bool small: false
    property bool enabled: true
    signal clicked()
    width: t.implicitWidth + (small ? 18 : 24); height: small ? 26 : 32; radius: small ? 7 : 9
    opacity: enabled ? 1 : 0.5
    color: primary ? (ma.containsMouse ? Qt.lighter(Theme.accent, 1.1) : Theme.accent) : ma.containsMouse ? Theme.hover : "transparent"
    border.color: primary ? "transparent" : danger ? Theme.alpha(Theme.danger, 0.5) : Theme.border
    Text { id: t; anchors.centerIn: parent; text: b.label; color: b.primary ? "#ffffff" : b.danger ? Theme.danger : Theme.text; font.family: Theme.font; font.pixelSize: small ? 12 : 13; font.weight: Font.DemiBold }
    MouseArea { id: ma; anchors.fill: parent; enabled: b.enabled; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: b.clicked() }
}
