import QtQuick

// An app's icon. NEXUS's own apps have a drawing (icons/app-<id>.svg). An app installed from NEXUS Store
// ("web-…", "linux-…": nexus-sessiond lists them in Session.apps with a `store` part) shows its own picture when it
// brought one (Linux apps), and otherwise a coloured tile with its first letter: NEXUS ships nobody's logo.
Image {
    id: ic
    property string app: ""
    readonly property var st: { var a = app ? Session.apps[app] : null; return a && a.store ? a.store : null }
    source: !app ? "" : st ? (st.image ? "file://" + st.image : "") : Qt.resolvedUrl("../icons/app-" + app + ".svg")
    sourceSize: Qt.size(Math.max(32, width * 2), Math.max(32, height * 2))
    smooth: true
    mipmap: true
    fillMode: Image.PreserveAspectFit
    Rectangle {
        visible: ic.st !== null && (ic.st.image === "" || ic.status === Image.Error)
        anchors.fill: parent; anchors.margins: parent.width * 0.06
        radius: width * 0.26
        gradient: Gradient {
            GradientStop { position: 0; color: Qt.lighter(ic.st ? ic.st.color : "#7c6cff", 1.25) }
            GradientStop { position: 1; color: ic.st ? ic.st.color : "#7c6cff" }
        }
        Text { anchors.centerIn: parent; text: ic.st ? ic.st.letter : ""; color: "#ffffff"; font.family: Theme.font; font.pixelSize: parent.width * 0.5; font.weight: Font.Bold }
    }
}
