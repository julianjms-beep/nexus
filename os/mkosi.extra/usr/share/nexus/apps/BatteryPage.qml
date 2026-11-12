import QtQuick
import "../shell"

// Ajustes → Batería: the charge and its health, what powers the computer, the power mode and when the screen locks.
Item {
    id: page
    property var st: null
    property string err: ""
    function load() { Session.request("GET", "/devices", null, function(s, j) { if (s === 200 && j) page.st = j }) }
    function post(p, b) { Session.request("POST", p, b, function(s, j) { page.err = s === 200 ? "" : (j && j.error ? j.error : "No se ha podido hacer el cambio."); page.load() }) }
    readonly property var bat: st ? st.battery : null
    readonly property var pw: st ? st.power : null
    readonly property var modeNames: ({ "power-saver": "Bajo consumo", balanced: "Equilibrado", performance: "Rendimiento" })
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Timer { interval: 10000; running: page.visible; repeat: true; onTriggered: page.load() }

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: page.bat ? "Batería" : "Energía"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                Item {
                    width: parent.width; height: 92
                    BatteryGlyph { visible: !!page.bat; y: 10; percent: page.bat ? page.bat.percent : 0; charging: !!page.bat && (page.bat.status === "Charging" || page.bat.status === "Full"); color: Theme.text; scale: 1.6; transformOrigin: Item.TopLeft }
                    LineIcon { visible: !page.bat; y: 8; name: "plug"; size: 34; stroke: 1.5; color: Theme.accent }
                    Column {
                        x: 70; y: 4
                        Text { text: page.bat ? page.bat.percent + " %" : "Enchufado a la corriente"; color: Theme.text; font.family: Theme.font; font.pixelSize: 30; font.weight: Font.Light }
                        Text {
                            text: !page.bat ? "Este equipo no tiene batería (un ordenador de sobremesa o una máquina virtual)."
                                : page.bat.status === "Charging" ? "Cargando" + (page.bat.minutes ? " · listo en " + page.minutesText(page.bat.minutes) : "")
                                : page.bat.status === "Full" ? "Carga completa · con el cargador"
                                : "Con batería" + (page.bat.minutes ? " · quedan unas " + page.minutesText(page.bat.minutes) : "")
                            color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                        }
                        Text { visible: !!page.bat && page.bat.health !== undefined; text: page.bat && page.bat.health !== undefined ? "Salud de la batería: " + page.bat.health + " %" + (page.bat.cycles ? " · " + page.bat.cycles + " ciclos" : "") : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                }
            }
            SettingsCard {
                title: "Modo de energía"
                note: !page.pw || !page.pw.available ? "Este equipo no permite elegir el modo de energía." : "Bajo consumo alarga la batería; Rendimiento da todo lo que el equipo tiene."
                Row {
                    visible: !!(page.pw && page.pw.available)
                    spacing: 8
                    Repeater {
                        model: page.pw && page.pw.modes ? page.pw.modes : []
                        Rectangle {
                            required property string modelData
                            readonly property bool on: page.pw && page.pw.mode === modelData
                            width: mt.implicitWidth + 28; height: 34; radius: 10
                            color: on ? Theme.alpha(Theme.accent, 0.2) : mma.containsMouse ? Theme.hover : Theme.card2
                            border.color: on ? Theme.accent : Theme.border
                            Text { id: mt; anchors.centerIn: parent; text: page.modeNames[modelData] || modelData; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: on ? Font.DemiBold : Font.Normal }
                            MouseArea { id: mma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.post("/devices/power", { mode: modelData }) }
                        }
                    }
                }
            }
            SettingsCard {
                title: "Pantalla y bloqueo"
                note: "Cuántos minutos sin tocar nada hasta que la pantalla se bloquea (también está en Privacidad y seguridad)."
                Row {
                    spacing: 8
                    Repeater {
                        model: [[0, "Nunca"], [1, "1 min"], [2, "2"], [5, "5"], [10, "10"], [15, "15"], [30, "30"], [60, "60"]]
                        Rectangle {
                            required property var modelData
                            readonly property bool on: (Session.prefs.lockAfter === undefined ? 5 : Session.prefs.lockAfter) === modelData[0]
                            width: lt.implicitWidth + 22; height: 30; radius: 8
                            color: on ? Theme.alpha(Theme.accent, 0.2) : lma.containsMouse ? Theme.hover : Theme.card2
                            border.color: on ? Theme.accent : Theme.border
                            Text { id: lt; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                            MouseArea { id: lma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("lockAfter", modelData[0]) }
                        }
                    }
                }
            }
        }
    }
    function minutesText(m) { return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min" }
}
