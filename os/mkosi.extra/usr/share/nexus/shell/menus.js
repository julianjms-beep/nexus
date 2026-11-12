.pragma library
// The menu bar's menus (shell/MenuBar.qml), like a Mac's: the NEXUS menu, then the active app's name and its menus.
// Linux apps on Wayland have no shared "global menu", so each item does something real another way:
//   keys: "ctrl+c"   that app's own shortcut, pressed in its window (nexus-sessiond POST /keys, a fixed list of keys)
//   win: "minimize"  a window action on the active window (POST /window: minimize, maximize, fullscreen, close)
//   act: {...}       NEXUS itself: launch an app, open Ajustes at a page, NEXUS AI, power, next wallpaper
//   hint: "super+q"  only shown (the keys that do the same), when the item does it another way
// The shortcuts are the apps' real ones: NEXUS Terminal's (usr/bin/nexus-terminal), VS Code's Linux defaults, and NEXUS's apps (apps/*.qml Shortcut{}).

var SEP = { sep: true };

function edit(extra) {
    var items = [
        { label: "Deshacer", keys: "ctrl+z" }, { label: "Rehacer", keys: "ctrl+shift+z" }, SEP,
        { label: "Cortar", keys: "ctrl+x" }, { label: "Copiar", keys: "ctrl+c" }, { label: "Pegar", keys: "ctrl+v" },
        { label: "Seleccionar todo", keys: "ctrl+a" }
    ];
    return { title: "Editar", items: extra ? items.concat([SEP], extra) : items };
}

function windowMenu() {
    return { title: "Ventana", items: [
        { label: "Minimizar", win: "minimize" },
        { label: "Ampliar o restaurar", keys: "super+Up" },
        { label: "Pantalla completa", win: "fullscreen" }, SEP,
        { label: "A la mitad izquierda", keys: "super+Left" },
        { label: "A la mitad derecha", keys: "super+Right" }, SEP,
        { label: "Cerrar ventana", win: "close", hint: "super+q" }
    ] };
}

function help(name) {
    return { title: "Ayuda", items: [
        { label: "Preguntar a NEXUS AI sobre " + name + "…", act: { ask: "¿Cómo hago en " + name + " para " } },
        { label: "Preguntar a NEXUS AI…", act: { panel: "ai" }, hint: "super+space" }
    ] };
}

// The menu under the app's name (Mac: About / Hide / Quit).
function appMenu(name, desktop) {
    if (desktop) return [
        { label: "Acerca de NEXUS OS", act: { settings: "acerca" } }, SEP,
        { label: "Ajustes…", act: { launch: "settings" } },
        { label: "Estilo del escritorio…", act: { settings: "apariencia" } }
    ];
    return [
        { label: "Preguntar a NEXUS AI sobre " + name + "…", act: { ask: "¿Cómo hago en " + name + " para " } }, SEP,
        { label: "Ocultar " + name, win: "minimize" },
        { label: "Salir de " + name, win: "close", hint: "super+q" }
    ];
}

/** The NEXUS menu (the logo, left): this computer, its settings and power. */
function systemMenu() {
    return [
        { label: "Acerca de NEXUS OS", act: { settings: "acerca" } }, SEP,
        { label: "Ajustes del sistema…", act: { launch: "settings" } },
        { label: "Actualizaciones…", act: { settings: "actualizaciones" } },
        { label: "Monitor de recursos", act: { launch: "monitor" } }, SEP,
        { label: "Todas las apps", act: { panel: "start" } }, SEP,
        { label: "Bloquear pantalla", act: { power: "lock" }, hint: "super+l" },
        { label: "Cerrar sesión…", act: { power: "logout" } },
        { label: "Reiniciar…", act: { power: "reboot" } },
        { label: "Apagar…", act: { power: "poweroff" } }
    ];
}

/** The menus after the app's name, for the active window (catalog id `app`, display `name`; "" = the desktop). */
function forApp(app, name) {
    if (!name) return [
        { title: "Archivo", items: [
            { label: "Nueva ventana de Archivos", act: { launch: "files" }, hint: "super+e" },
            { label: "Nueva terminal", act: { launch: "terminal" }, hint: "super+Return" }
        ] },
        { title: "Ver", items: [
            { label: "Siguiente fondo", act: { wallpaper: "next" } },
            { label: "Cambiar el fondo…", act: { settings: "fondo" } },
            { label: "Estilo del escritorio…", act: { settings: "apariencia" } }
        ] },
        { title: "Ir", items: [
            { label: "Todas las apps", act: { panel: "start" } },
            { label: "Carpeta personal", act: { launch: "files" } }
        ] },
        help("NEXUS")
    ];
    if (app === "terminal") return [
        { title: "Shell", items: [
            { label: "Pestaña nueva", keys: "ctrl+shift+t" }, { label: "Ventana nueva", keys: "ctrl+shift+n" }, SEP,
            { label: "Dividir a la derecha", keys: "ctrl+shift+d" }, { label: "Dividir abajo", keys: "ctrl+shift+e" }, SEP,
            { label: "Cerrar panel o pestaña", keys: "ctrl+shift+w" }, { label: "Cerrar ventana", win: "close", hint: "super+q" }
        ] },
        { title: "Editar", items: [
            { label: "Copiar", keys: "ctrl+shift+c" }, { label: "Pegar", keys: "ctrl+shift+v" }, SEP,
            { label: "Buscar en pantalla", keys: "ctrl+shift+f" }, { label: "Buscar en el historial", keys: "ctrl+r" }
        ] },
        { title: "Ver", items: [
            { label: "Pestaña siguiente", keys: "ctrl+Tab" }, { label: "Pestaña anterior", keys: "ctrl+shift+Tab" },
            { label: "Nombre de la pestaña…", keys: "ctrl+shift+r" }, SEP,
            { label: "Ampliar el panel", keys: "ctrl+shift+z" }, SEP,
            { label: "Aumentar texto", keys: "ctrl+plus" }, { label: "Reducir texto", keys: "ctrl+minus" },
            { label: "Tamaño normal", keys: "ctrl+0" }, SEP, { label: "Pantalla completa", win: "fullscreen" }, SEP,
            { label: "Ajustes de Terminal…", act: { settings: "terminal" } }
        ] },
        windowMenu(), help(name)
    ];
    if (app === "code") return [
        { title: "Archivo", items: [
            { label: "Nuevo archivo", keys: "ctrl+n" }, { label: "Abrir archivo…", keys: "ctrl+o" }, SEP,
            { label: "Guardar", keys: "ctrl+s" }, { label: "Guardar como…", keys: "ctrl+shift+s" }, SEP,
            { label: "Nueva ventana", keys: "ctrl+shift+n" }, { label: "Cerrar editor", keys: "ctrl+w" }
        ] },
        edit([{ label: "Buscar", keys: "ctrl+f" }, { label: "Reemplazar", keys: "ctrl+h" }, { label: "Buscar en los archivos", keys: "ctrl+shift+f" }]),
        { title: "Ver", items: [
            { label: "Paleta de comandos…", keys: "ctrl+shift+p" }, SEP,
            { label: "Explorador", keys: "ctrl+shift+e" }, { label: "Control de código fuente", keys: "ctrl+shift+g" },
            { label: "Extensiones", keys: "ctrl+shift+x" }, { label: "Terminal", keys: "ctrl+grave" }, SEP,
            { label: "Pantalla completa", keys: "F11" }, { label: "Ampliar", keys: "ctrl+equal" }, { label: "Reducir", keys: "ctrl+minus" }
        ] },
        { title: "Ir", items: [
            { label: "Ir al archivo…", keys: "ctrl+p" }, { label: "Ir a la línea…", keys: "ctrl+g" },
            { label: "Ir al símbolo…", keys: "ctrl+shift+o" }
        ] },
        { title: "Ejecutar", items: [
            { label: "Iniciar depuración", keys: "F5" }, { label: "Ejecutar sin depurar", keys: "ctrl+F5" }
        ] },
        { title: "Terminal", items: [{ label: "Nuevo terminal", keys: "ctrl+shift+grave" }] },
        windowMenu(), help(name)
    ];
    if (app === "browser") return [
        { title: "Archivo", items: [
            { label: "Nueva pestaña", keys: "ctrl+t" }, { label: "Cerrar pestaña", keys: "ctrl+w" }, SEP,
            { label: "Escribir una dirección", keys: "ctrl+l" }
        ] },
        edit([{ label: "Buscar en la página", keys: "ctrl+f" }]),
        { title: "Ver", items: [
            { label: "Recargar", keys: "ctrl+r" }, { label: "Recargar sin caché", keys: "ctrl+shift+r" }, SEP,
            { label: "Ampliar", keys: "ctrl+equal" }, { label: "Reducir", keys: "ctrl+minus" }, { label: "Tamaño real", keys: "ctrl+0" }, SEP,
            { label: "Código fuente", keys: "ctrl+u" }, { label: "Herramientas de desarrollo", keys: "F12" },
            { label: "Preguntar a NEXUS AI sobre la página", keys: "ctrl+j" }
        ] },
        { title: "Historial", items: [{ label: "Atrás", keys: "alt+Left" }, { label: "Adelante", keys: "alt+Right" }] },
        { title: "Pestañas", items: [{ label: "Siguiente pestaña", keys: "ctrl+Tab" }, { label: "Pestaña anterior", keys: "ctrl+shift+Tab" }] },
        windowMenu(), help(name)
    ];
    if (app === "files") return [
        { title: "Archivo", items: [
            { label: "Nueva ventana", act: { launch: "files" }, hint: "super+e" },
            { label: "Nueva carpeta", keys: "ctrl+shift+n" }, SEP,
            { label: "Cerrar ventana", win: "close", hint: "super+q" }
        ] },
        edit([{ label: "Buscar", keys: "ctrl+f" }]),
        { title: "Ir", items: [{ label: "Atrás", keys: "alt+Left" }, { label: "Adelante", keys: "alt+Right" }] },
        windowMenu(), help(name)
    ];
    if (app === "agents" || app === "automations") return [
        { title: "Archivo", items: [
            { label: app === "agents" ? "Nuevo agente" : "Nueva automatización", keys: "ctrl+n" }, SEP,
            { label: "Cerrar ventana", win: "close", hint: "super+q" }
        ] },
        edit(), windowMenu(), help(name)
    ];
    if (app === "connect") return [
        { title: "Archivo", items: [{ label: "Cerrar ventana", win: "close", hint: "super+q" }] },
        edit(), windowMenu(), help(name)
    ];
    // NEXUS's other apps (Notas, Monitor, Ajustes) and anyone else's: the usual menus every app understands
    return [
        { title: "Archivo", items: [
            { label: "Nueva ventana", keys: "ctrl+n" }, SEP,
            { label: "Cerrar ventana", win: "close", hint: "super+q" }
        ] },
        edit([{ label: "Buscar", keys: "ctrl+f" }]),
        { title: "Ver", items: [{ label: "Pantalla completa", win: "fullscreen" }] },
        windowMenu(), help(name)
    ];
}

/** "ctrl+shift+c" -> "Ctrl+Mayús+C" (how the menus show a shortcut). */
function pretty(keys) {
    if (!keys) return "";
    var names = { ctrl: "Ctrl", shift: "Mayús", alt: "Alt", "super": "Super", plus: "+", minus: "−", equal: "=", grave: "`",
                  Up: "↑", Down: "↓", Left: "←", Right: "→", Return: "Intro", space: "Espacio", Tab: "Tab" };
    return keys.split("+").map(function(k) { return names[k] || (k.length === 1 ? k.toUpperCase() : k) }).join("+");
}
