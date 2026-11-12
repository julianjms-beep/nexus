import QtQuick
import QtQuick.Controls
import "../shell"

// Ajustes → Terminal: how NEXUS Terminal looks (colours, font, size, cursor) and what it does on its own (the
// greeting, the suggestions from the history). The choices are ordinary preferences (nexus-sessiond /prefs:
// termTheme, termFont, termSize, termCursor, termWelcome, termSuggest); usr/bin/nexus-terminal reads them when a
// window opens, so a change shows in the next window, and in the preview here at once.
// The colours below are the same ones usr/bin/nexus-terminal writes: keep the two in step.
Item {
    id: page
    readonly property var themes: [
        { id: "auto", name: "Automático" },
        { id: "oscuro", name: "NEXUS", bg: "#0b0d14", fg: "#dfe2f0", bar: "#06070c", dim: "#7d859f", green: "#3ddc97", red: "#ff5c7a", blue: "#6c8cff", yellow: "#ffb84d" },
        { id: "claro", name: "Claro", bg: "#f7f8fc", fg: "#1c2030", bar: "#e6e9f2", dim: "#6b7390", green: "#1a8f5c", red: "#d6336c", blue: "#3b5bdb", yellow: "#b7791f" },
        { id: "oceano", name: "Océano", bg: "#0a1722", fg: "#d6e6f2", bar: "#06101a", dim: "#6f8ba0", green: "#4fd6a0", red: "#ff6b81", blue: "#4ea8ff", yellow: "#ffc66d" },
        { id: "grafito", name: "Grafito", bg: "#1c1c1e", fg: "#e5e5ea", bar: "#141416", dim: "#8e8e93", green: "#32d74b", red: "#ff453a", blue: "#0a84ff", yellow: "#ffd60a" }
    ]
    readonly property string theme: Session.prefs.termTheme || "auto"
    readonly property string fontName: Session.prefs.termFont || "JetBrains Mono"
    readonly property int fontSize: Session.prefs.termSize || 11
    readonly property string cursor: Session.prefs.termCursor || "beam"
    readonly property bool welcome: Session.prefs.termWelcome !== false
    readonly property bool suggest: Session.prefs.termSuggest !== false
    function look(id) {
        var want = id === "auto" ? (Theme.dark ? "oscuro" : "claro") : id
        for (var i = 0; i < themes.length; i++) if (themes[i].id === want) return themes[i]
        return themes[1]
    }
    readonly property var cur: look(theme)
    readonly property string acc: "" + Theme.accent

    component Pill: Rectangle {
        id: pl
        property string label: ""
        property bool on: false
        signal clicked()
        width: plText.implicitWidth + 26; height: 32; radius: 16
        color: on ? Theme.accent : plArea.containsMouse ? Theme.hover : Theme.card2
        Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
        Text { id: plText; anchors.centerIn: parent; text: pl.label; color: pl.on ? "#ffffff" : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: pl.on ? Font.DemiBold : Font.Normal }
        MouseArea { id: plArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: pl.clicked() }
    }
    component Heading: Text { color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold; font.letterSpacing: 1; leftPadding: 4; topPadding: 6 }
    component Note: Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
    component SwitchRow: Item {
        id: sr
        property string title: ""
        property string note: ""
        property bool on: false
        signal changed(bool value)
        width: parent.width; height: Math.max(48, srCol.height + 8)
        Column { id: srCol; width: parent.width - 70; spacing: 2; anchors.verticalCenter: parent.verticalCenter
            Text { text: sr.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.Medium }
            Text { width: parent.width; wrapMode: Text.Wrap; text: sr.note; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.2 }
        }
        NexusSwitch { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; checked: sr.on; onToggled: sr.changed(checked) }
    }
    component T: Text { font.family: page.fontName; font.pixelSize: Math.round(page.fontSize * 1.34); color: page.cur.fg; textFormat: Text.StyledText }

    Flickable {
        anchors.fill: parent
        contentWidth: width; contentHeight: col.height + 28
        clip: true; boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: col
            width: Math.min(parent.width - 14, 700)
            spacing: 14
            Text { text: "Terminal"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }

            // ---------------- the preview: a small terminal in the chosen colours, font, size and cursor
            Rectangle {
                id: prev
                width: parent.width; height: prevCol.height + 58; radius: 16; clip: true
                color: page.cur.bg; border.color: Theme.border
                Behavior on color { ColorAnimation { duration: Theme.ms(180) } }
                readonly property int px: Math.round(page.fontSize * 1.34)
                readonly property string promptText: "<font color='" + page.acc + "'>◆</font> ~/proyecto <font color='" + page.cur.green + "'>main*</font> <font color='" + page.acc + "'>❯</font> "
                Rectangle {   // the tab bar
                    width: parent.width; height: 30; color: page.cur.bar
                    Rectangle { x: 12; width: tabA.width + 38; height: 30; color: page.cur.bg
                        Rectangle { x: 11; anchors.verticalCenter: parent.verticalCenter; width: 7; height: 7; radius: 4; color: Theme.accent }
                        Text { id: tabA; x: 26; anchors.verticalCenter: parent.verticalCenter; text: "proyecto"; color: page.cur.fg; font.family: page.fontName; font.pixelSize: 12; font.weight: Font.DemiBold } }
                    Text { x: tabA.width + 68; anchors.verticalCenter: parent.verticalCenter; text: "node"; color: page.cur.dim; font.family: page.fontName; font.pixelSize: 12 }
                    Text { x: tabA.width + 122; anchors.verticalCenter: parent.verticalCenter; text: "+"; color: page.cur.dim; font.family: page.fontName; font.pixelSize: 13 }
                    Text { anchors.right: parent.right; anchors.rightMargin: 14; anchors.verticalCenter: parent.verticalCenter; text: "~/proyecto"; color: page.cur.dim; font.family: page.fontName; font.pixelSize: 12 }
                }
                Column {
                    id: prevCol
                    x: 16; y: 42; spacing: Math.round(prev.px * 0.3)
                    T { text: prev.promptText + "<font color='" + page.cur.green + "'>git</font> status" }
                    T { text: "En la rama main · <font color='" + page.cur.red + "'>modificado:</font> src/app.ts" }
                    T { text: prev.promptText + "<font color='" + page.cur.green + "'>ai</font> ¿por qué falla el test?" }
                    T { text: "<font color='" + page.cur.blue + "'>NEXUS AI</font> <font color='" + page.cur.dim + "'>Falta esperar a la promesa en la línea 14.</font>" }
                    Row {
                        T { text: prev.promptText + "<font color='" + page.cur.green + "'>npm</font>" }
                        Item { width: Math.round(prev.px * 0.6); height: 1 }   // (styled text drops a trailing space)
                        Rectangle {   // the cursor
                            y: page.cursor === "underline" ? prev.px + 1 : 1
                            width: page.cursor === "beam" ? 2 : Math.round(prev.px * 0.6); height: page.cursor === "underline" ? 2 : prev.px + 2
                            color: Theme.accent
                            SequentialAnimation on opacity { loops: Animation.Infinite; running: page.visible
                                PauseAnimation { duration: 550 } NumberAnimation { to: 0; duration: 60 } PauseAnimation { duration: 450 } NumberAnimation { to: 1; duration: 60 } }
                        }
                        T { visible: page.suggest; text: (page.cursor === "beam" ? "" : " ") + "run test -- --watch"; color: page.cur.dim }
                    }
                }
            }
            Note { text: "Así se verá la próxima ventana de Terminal que abras. Las que ya están abiertas no cambian."; color: Theme.faint; font.pixelSize: 12 }

            // ---------------- colours
            Heading { text: "COLORES" }
            Rectangle {
                width: parent.width; height: themeCol.height + 36; radius: 16; color: Theme.card; border.color: Theme.border
                Column {
                    id: themeCol
                    x: 18; y: 18; width: parent.width - 36; spacing: 12
                    Row {
                        id: swRow
                        width: parent.width; spacing: 10
                        Repeater {
                            model: page.themes
                            Item {
                                id: sw
                                required property var modelData
                                readonly property var lk: page.look(modelData.id)
                                readonly property bool on: page.theme === modelData.id
                                width: Math.floor((swRow.width - 40) / 5); height: 96
                                Rectangle {
                                    width: parent.width; height: 70; radius: 12; color: sw.lk.bg; clip: true
                                    border.color: sw.on ? Theme.accent : Theme.border; border.width: sw.on ? 2 : 1
                                    // «Automático» follows the light or dark mode of the desktop: half and half
                                    Rectangle { visible: sw.modelData.id === "auto"; x: parent.width / 2; y: 2; width: parent.width / 2 - 2; height: parent.height - 4; radius: 10; color: page.look(Theme.dark ? "claro" : "oscuro").bg }
                                    Row { x: 12; y: 18; spacing: 5
                                        Rectangle { width: 8; height: 8; radius: 4; color: Theme.accent } Rectangle { width: 30; height: 8; radius: 4; color: sw.lk.green } Rectangle { width: 20; height: 8; radius: 4; color: sw.lk.fg; opacity: 0.8 } }
                                    Row { x: 12; y: 34; spacing: 5
                                        Rectangle { width: 22; height: 8; radius: 4; color: sw.lk.red } Rectangle { width: 38; height: 8; radius: 4; color: sw.lk.dim } }
                                    Row { x: 12; y: 50; spacing: 5
                                        Rectangle { width: 8; height: 8; radius: 4; color: Theme.accent } Rectangle { width: 26; height: 8; radius: 4; color: sw.lk.blue } }
                                }
                                Text { anchors.horizontalCenter: parent.horizontalCenter; y: 76; text: sw.modelData.name; color: sw.on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: sw.on ? Font.DemiBold : Font.Normal }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("termTheme", sw.modelData.id) }
                            }
                        }
                    }
                    Note { text: "«Automático» sigue el modo claro u oscuro del escritorio. El color de las pestañas y del cursor es el color de acento de Ajustes → Apariencia." }
                }
            }

            // ---------------- font, size, cursor
            Heading { text: "LETRA" }
            Rectangle {
                width: parent.width; height: fontCol.height + 36; radius: 16; color: Theme.card; border.color: Theme.border
                Column {
                    id: fontCol
                    x: 18; y: 18; width: parent.width - 36; spacing: 14
                    Row {
                        spacing: 8
                        Repeater {
                            model: [["JetBrains Mono", "JetBrains Mono"], ["JetBrains Mono NL", "JetBrains sin ligaduras"], ["DejaVu Sans Mono", "DejaVu"]]
                            Pill { required property var modelData; label: modelData[1]; on: page.fontName === modelData[0]; onClicked: Session.setPref("termFont", modelData[0]) }
                        }
                    }
                    Row {
                        spacing: 14
                        Text { anchors.verticalCenter: parent.verticalCenter; width: 64; text: "Tamaño"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                        Text { anchors.verticalCenter: parent.verticalCenter; text: "A"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                        Slider {
                            id: sizeSlider
                            anchors.verticalCenter: parent.verticalCenter
                            width: 300; from: 9; to: 20; stepSize: 1; snapMode: Slider.SnapAlways
                            value: page.fontSize
                            onMoved: if (Math.round(value) !== page.fontSize) Session.setPref("termSize", Math.round(value))
                            background: Rectangle { x: sizeSlider.leftPadding; y: sizeSlider.topPadding + sizeSlider.availableHeight / 2 - 2; width: sizeSlider.availableWidth; height: 4; radius: 2; color: Theme.card2
                                Rectangle { width: sizeSlider.visualPosition * parent.width; height: 4; radius: 2; color: Theme.accent } }
                            handle: Rectangle { x: sizeSlider.leftPadding + sizeSlider.visualPosition * (sizeSlider.availableWidth - width); y: sizeSlider.topPadding + sizeSlider.availableHeight / 2 - 9; width: 18; height: 18; radius: 9; color: "#ffffff"; border.color: Theme.border }
                        }
                        Text { anchors.verticalCenter: parent.verticalCenter; text: "A"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 19 }
                        Text { anchors.verticalCenter: parent.verticalCenter; text: page.fontSize + " pt"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    }
                    Row {
                        spacing: 8
                        Text { anchors.verticalCenter: parent.verticalCenter; width: 70; text: "Cursor"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                        Repeater {
                            model: [["beam", "Línea"], ["block", "Bloque"], ["underline", "Subrayado"]]
                            Pill { required property var modelData; label: modelData[1]; on: page.cursor === modelData[0]; onClicked: Session.setPref("termCursor", modelData[0]) }
                        }
                    }
                }
            }

            // ---------------- behaviour
            Heading { text: "AL ESCRIBIR" }
            Rectangle {
                width: parent.width; height: behCol.height + 20; radius: 16; color: Theme.card; border.color: Theme.border
                Column {
                    id: behCol
                    x: 18; y: 10; width: parent.width - 36; spacing: 4
                    SwitchRow { title: "Sugerencias del historial"; note: "Mientras escribes aparece en gris la orden que usaste otras veces. La flecha → la acepta."; on: page.suggest; onChanged: (value) => Session.setPref("termSuggest", value) }
                    Rectangle { width: parent.width; height: 1; color: Theme.border }
                    SwitchRow { title: "Saludo al abrir"; note: "Lo que hay instalado (node, python, git…) y los atajos, al abrir cada ventana."; on: page.welcome; onChanged: (value) => Session.setPref("termWelcome", value) }
                }
            }

            // ---------------- shortcuts
            Heading { text: "ATAJOS" }
            Rectangle {
                width: parent.width; height: keyGrid.height + 36; radius: 16; color: Theme.card; border.color: Theme.border
                Grid {
                    id: keyGrid
                    x: 18; y: 18; width: parent.width - 36; columns: 2; columnSpacing: 24; rowSpacing: 10
                    Repeater {
                        model: [["Ctrl+Mayús+T", "Pestaña nueva"], ["Ctrl+Mayús+W", "Cerrar panel o pestaña"], ["Ctrl+Mayús+D", "Dividir a la derecha"], ["Ctrl+Mayús+E", "Dividir abajo"],
                                ["Ctrl+Mayús+flechas", "Cambiar de panel"], ["Ctrl+Mayús+Z", "Ampliar el panel"], ["Ctrl+Tab", "Pestaña siguiente"], ["Alt+1…9", "Ir a esa pestaña"],
                                ["Ctrl+Mayús+R", "Nombre de la pestaña"], ["Ctrl+Mayús+F", "Buscar en pantalla"], ["Ctrl+R", "Buscar en el historial"], ["Ctrl+Mayús+N", "Ventana nueva"],
                                ["Ctrl+Mayús+C / V", "Copiar y pegar"], ["Ratón", "Seleccionar ya copia"]]
                        Row {
                            required property var modelData
                            width: (keyGrid.width - 24) / 2; spacing: 10
                            Rectangle { width: 140; height: 24; radius: 7; color: Theme.card2; border.color: Theme.border
                                Text { anchors.centerIn: parent; text: modelData[0]; color: Theme.text; font.family: Theme.mono; font.pixelSize: 11 } }
                            Text { anchors.verticalCenter: parent.verticalCenter; text: modelData[1]; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                        }
                    }
                }
            }
            Item { width: 1; height: 4 }
        }
    }
}
