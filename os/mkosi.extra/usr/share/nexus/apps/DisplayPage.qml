import QtQuick
import "../shell"

// Ajustes → Pantalla: brightness, the size of everything (the interface scale), and each screen's resolution.
Item {
    id: page
    property var st: null
    property var disp: null
    property string err: ""
    function load() {
        Session.request("GET", "/devices", null, function(s, j) { if (s === 200 && j) page.st = j })
        Session.request("GET", "/devices/display", null, function(s, j) { if (s === 200 && j) page.disp = j })
    }
    function post(p, b) { Session.request("POST", p, b, function(s, j) { page.err = s === 200 ? "" : (j && j.error ? j.error : "No se ha podido hacer el cambio."); page.load() }) }
    readonly property var br: st ? st.brightness : null
    readonly property var scales: [["auto", "Auto"], [1, "100 %"], [1.25, "125 %"], [1.5, "150 %"], [1.75, "175 %"], [2, "200 %"]]
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: "Pantalla"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                title: "Brillo"
                note: page.br && !page.br.available ? "Esta pantalla no permite cambiar el brillo desde aquí (un monitor externo o una máquina virtual)." : ""
                SettingsSlider { icon: "sun"; label: "Brillo"; enabled: !!(page.br && page.br.available); value: page.br && page.br.available ? page.br.value : 100; onMoved: (v) => page.post("/devices/brightness", { value: v }) }
            }
            SettingsCard {
                title: "Tamaño de la interfaz"
                note: "Letras, ventanas y botones más grandes o más pequeños. «Auto» elige según la pantalla."
                Row {
                    spacing: 8
                    Repeater {
                        model: page.scales
                        Rectangle {
                            required property var modelData
                            readonly property bool on: (Session.prefs.scale === undefined ? "auto" : Session.prefs.scale) === modelData[0]
                            width: st2.implicitWidth + 22; height: 32; radius: 9
                            color: on ? Theme.alpha(Theme.accent, 0.2) : sma.containsMouse ? Theme.hover : Theme.card2
                            border.color: on ? Theme.accent : Theme.border
                            Text { id: st2; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                            MouseArea { id: sma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("scale", modelData[0]) }
                        }
                    }
                }
            }
            Repeater {
                model: page.disp && page.disp.outputs ? page.disp.outputs : []
                SettingsCard {
                    required property var modelData
                    title: "Resolución" + (modelData.description ? " · " + modelData.description : page.disp.outputs.length > 1 ? " · " + modelData.name : "")
                    note: "El tamaño en píxeles de esta pantalla. El marcado es el que está en uso."
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater {
                            model: modelData.modes.slice(0, 12)
                            Rectangle {
                                required property var modelData
                                readonly property var out: parent.parent.modelData
                                readonly property string spec: modelData.width + "x" + modelData.height + "@" + modelData.hz
                                width: rt.implicitWidth + 22; height: 32; radius: 9
                                color: modelData.current ? Theme.alpha(Theme.accent, 0.2) : rma.containsMouse ? Theme.hover : Theme.card2
                                border.color: modelData.current ? Theme.accent : Theme.border
                                Text { id: rt; anchors.centerIn: parent; text: modelData.width + " × " + modelData.height + (modelData.hz && modelData.hz !== 60 ? " · " + modelData.hz + " Hz" : "") + (modelData.preferred ? " ★" : ""); color: modelData.current ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                                MouseArea { id: rma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.post("/devices/display/mode", { output: out.name, mode: spec }) }
                            }
                        }
                    }
                }
            }
        }
    }
}
