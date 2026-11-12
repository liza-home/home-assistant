/**
 * Panel vocabulary.
 *
 * The panel spoke English at every user regardless of what Home Assistant was
 * set to, including the four languages this integration already ships for its
 * config flow. This module is the one place that is fixed.
 *
 * One table, whose entries come in two shapes.
 *
 * 1. An entry with an **`ha`** key names a string the frontend already has,
 *    and that one wins. A word Home Assistant owns is worth more than a word
 *    we translate ourselves: it is reviewed, it is complete in every language
 *    HA supports rather than the five we can write, and it makes our menus
 *    read like the rest of the interface instead of like a plugin. Only keys
 *    reachable from inside this panel may be named — the core bundle plus the
 *    `config` fragment, which `_loadHaTranslations()` pulls in on entry.
 *    `localize` answers "" for a fragment that is not loaded, so these entries
 *    also carry English, and only English: a second German for "Delete" would
 *    be read only when HA's is missing, and would rot unnoticed until then.
 *
 * 2. Every other entry is ours, for the phrases that are about this panel and
 *    have no counterpart anywhere in the frontend ("Page default", "Pinned in
 *    YAML"). These carry all five languages. English is the fallback for every
 *    language we do not write, so a gap degrades to the behaviour the panel
 *    had before rather than to a blank label.
 *
 * Phrases spelled identically in all five — "URL", "Min", "Max" — are not here
 * at all; they stay plain literals at their call sites.
 *
 * `{name}`-style placeholders are substituted by `_t`. They exist so a
 * sentence stays one translatable unit: German and French put the verb
 * somewhere English does not, and a sentence assembled from three concatenated
 * fragments cannot be reordered by a translator.
 */

/** id → { en, de, fr, it, es }. English doubles as the fallback. */
export const STRINGS = {
  // ── what Home Assistant already says ───────────────────────────────
  //
  // `ha` names the frontend's own string, which wins whenever `localize`
  // answers. The English beside it is what remains when it does not: an
  // unloaded fragment, or a key a future frontend renames. Deliberately not
  // borrowed: "Label", which in HA is the tagging feature and here is a
  // button's caption, and "Control", which for us names the quantity a slider
  // writes rather than the widget HA means by it.
  cancel: { ha: "ui.common.cancel", en: "Cancel" },
  close: { ha: "ui.common.close", en: "Close" },
  delete: { ha: "ui.common.delete", en: "Delete" },
  name: { ha: "ui.common.name", en: "Name" },
  icon: { ha: "ui.dialogs.label-detail.icon", en: "Icon" },
  image: { ha: "ui.components.selectors.image.image", en: "Image" },
  filter: { ha: "ui.components.related-filter-menu.filter", en: "Filter…" },
  move: { ha: "ui.common.move", en: "Move" },
  clear: { ha: "ui.common.clear", en: "Clear" },
  actions: { ha: "ui.panel.config.generic.headers.actions", en: "Actions" },
  delete_failed: { ha: "ui.common.deleting_failed", en: "Deleting failed" },
  attribute: { ha: "ui.components.selectors.selector.types.attribute", en: "Attribute" },
  entity: { ha: "ui.components.selectors.selector.types.entity", en: "Entity" },
  service: { ha: "ui.dialogs.more_info_control.device_type.service", en: "Service" },

  // Not here on purpose: "URL", "Min", "Max" and the debug tab's "Ping". They
  // are spelled the same in all five languages, so they stay plain literals at
  // their call sites — routing them through `_t` would only add a lookup that
  // can never differ.

  // ── tabs and section headings ──────────────────────────────────────
  tab_pages: {
    en: "Pages", de: "Seiten", fr: "Pages", it: "Pagine", es: "Páginas",
  },

  // ── settings tab ───────────────────────────────────────────────────
  tab_settings: {
    en: "Settings", de: "Einstellungen", fr: "Paramètres", it: "Impostazioni", es: "Ajustes",
  },
  settings_title: {
    en: "Page title", de: "Seitentitel", fr: "Titre de page", it: "Titolo pagina", es: "Título de página",
  },
  settings_tooltip: {
    en: "Tooltip", de: "Tooltip", fr: "Info-bulle", it: "Descrizione comando", es: "Información sobre herramientas",
  },
  settings_font_size: {
    en: "Font size", de: "Schriftgröße", fr: "Taille de police", it: "Dimensione carattere", es: "Tamaño de fuente",
  },
  settings_font_missing: {
    en: "{name} (not installed)", de: "{name} (nicht installiert)", fr: "{name} (non installée)",
    it: "{name} (non installato)", es: "{name} (no instalada)",
  },
  settings_theme: {
    en: "Theme", de: "Design", fr: "Thème", it: "Tema", es: "Tema",
  },
  settings_theme_download: {
    en: "Download theme", de: "Design herunterladen", fr: "Télécharger le thème",
    it: "Scarica tema", es: "Descargar tema",
  },
  settings_theme_download_failed: {
    en: "Could not download the theme: {error}",
    de: "Design konnte nicht heruntergeladen werden: {error}",
    fr: "Impossible de télécharger le thème : {error}",
    it: "Impossibile scaricare il tema: {error}",
    es: "No se pudo descargar el tema: {error}",
  },
  settings_theme_drop_hint: {
    en: "or drop a theme file here, or drag a theme here to copy it",
    de: "oder eine Design-Datei hier ablegen, oder ein Design hierher ziehen, um es zu kopieren",
    fr: "ou déposez un fichier de thème ici, ou faites glisser un thème ici pour le copier",
    it: "o trascina qui un file tema, oppure trascina qui un tema per copiarlo",
    es: "o suelta aquí un archivo de tema, o arrastra aquí un tema para copiarlo",
  },
  settings_theme_import_done: {
    en: "Added theme “{name}”", de: "Design „{name}“ hinzugefügt",
    fr: "Thème « {name} » ajouté", it: "Tema “{name}” aggiunto",
    es: "Tema «{name}» añadido",
  },
  settings_theme_import_failed: {
    en: "This file could not be added as a theme: {error}",
    de: "Diese Datei konnte nicht als Design hinzugefügt werden: {error}",
    fr: "Ce fichier n’a pas pu être ajouté comme thème : {error}",
    it: "Impossibile aggiungere questo file come tema: {error}",
    es: "No se pudo añadir este archivo como tema: {error}",
  },
  settings_theme_import_too_big: {
    en: "it is too large to be a theme file", de: "sie ist zu groß für eine Design-Datei",
    fr: "il est trop volumineux pour un fichier de thème",
    it: "è troppo grande per essere un file tema",
    es: "es demasiado grande para ser un archivo de tema",
  },
  settings_theme_view_heading: {
    en: "View theme", de: "Design ansehen", fr: "Voir le thème",
    it: "Visualizza tema", es: "Ver tema",
  },
  settings_theme_edit_heading: {
    en: "Edit theme", de: "Design bearbeiten", fr: "Modifier le thème",
    it: "Modifica tema", es: "Editar tema",
  },
  settings_theme_close_confirm: {
    en: "Close without saving?", de: "Ohne Speichern schließen?",
    fr: "Fermer sans enregistrer ?", it: "Chiudere senza salvare?",
    es: "¿Cerrar sin guardar?",
  },
  settings_theme_close_hint: {
    en: "The changes you made here have not been written to a theme file yet.",
    de: "Die hier gemachten Änderungen wurden noch in keine Designdatei geschrieben.",
    fr: "Les modifications faites ici n'ont pas encore été écrites dans un fichier de thème.",
    it: "Le modifiche fatte qui non sono ancora state scritte in un file di tema.",
    es: "Los cambios hechos aquí todavía no se han escrito en un archivo de tema.",
  },
  settings_theme_close_discard: {
    en: "Discard", de: "Verwerfen", fr: "Abandonner",
    it: "Scarta", es: "Descartar",
  },
  settings_theme_readonly_hint: {
    en: "This theme comes with the integration, so it can be read but not changed. Make a copy to change it.",
    de: "Dieses Design kommt mit der Integration und lässt sich lesen, aber nicht ändern. Lege eine Kopie an, um es zu ändern.",
    fr: "Ce thème est fourni avec l'intégration : il se lit mais ne se modifie pas. Faites-en une copie pour le changer.",
    it: "Questo tema è incluso nell'integrazione: si può leggere ma non modificare. Creane una copia per cambiarlo.",
    es: "Este tema viene con la integración: se puede leer pero no cambiar. Haz una copia para cambiarlo.",
  },
  settings_theme_add: {
    en: "Create…", de: "Erstellen…", fr: "Créer…",
    it: "Crea…", es: "Crear…",
  },
  settings_theme_new_title: {
    en: "New theme", de: "Neues Design", fr: "Nouveau thème",
    it: "Nuovo tema", es: "Tema nuevo",
  },
  settings_theme_create: {
    en: "Create theme", de: "Design anlegen", fr: "Créer le thème",
    it: "Crea tema", es: "Crear tema",
  },
  settings_theme_copy: {
    en: "Make a copy I can change",
    de: "Kopie anlegen, die ich ändern kann",
    fr: "En faire une copie modifiable",
    it: "Creane una copia che posso modificare",
    es: "Hacer una copia que pueda cambiar",
  },
  settings_theme_delete: {
    en: "Delete theme", de: "Design löschen", fr: "Supprimer le thème",
    it: "Elimina tema", es: "Eliminar tema",
  },
  settings_theme_delete_confirm: {
    en: "Delete “{name}”?",
    de: "„{name}“ löschen?",
    fr: "Supprimer « {name} » ?",
    it: "Eliminare “{name}”?",
    es: "¿Eliminar «{name}»?",
  },
  settings_theme_delete_hint: {
    en: "This theme will be permanently deleted. A remote using it keeps the name and falls back to the default look.",
    de: "Dieses Design wird endgültig gelöscht. Eine Fernbedienung, die es verwendet, behält den Namen und fällt auf das Standardaussehen zurück.",
    fr: "Ce thème sera définitivement supprimé. Une télécommande qui l’utilise gardera son nom et reviendra à l’apparence par défaut.",
    it: "Questo tema verrà eliminato definitivamente. Un telecomando che lo usa manterrà il nome e tornerà all’aspetto predefinito.",
    es: "Este tema se eliminará permanentemente. Un mando que lo use conservará el nombre y volverá al aspecto predeterminado.",
  },
  settings_theme_name: {
    en: "Theme name", de: "Name des Designs", fr: "Nom du thème",
    it: "Nome del tema", es: "Nombre del tema",
  },
  settings_theme_name_hint: {
    en: "Saved in {path} as a file you can also edit by hand.",
    de: "Wird in {path} als Datei gespeichert, die du auch von Hand bearbeiten kannst.",
    fr: "Enregistré dans {path} comme un fichier que vous pouvez aussi modifier à la main.",
    it: "Salvato in {path} come file che puoi anche modificare a mano.",
    es: "Se guarda en {path} como un archivo que también puedes editar a mano.",
  },
  settings_theme_new_name: {
    en: "Copy of {name}", de: "Kopie von {name}", fr: "Copie de {name}",
    it: "Copia di {name}", es: "Copia de {name}",
  },
  settings_theme_blank_name: {
    en: "My theme", de: "Mein Design", fr: "Mon thème",
    it: "Il mio tema", es: "Mi tema",
  },
  settings_theme_states_hint: {
    en: "What a button falls back to, tinted by what the entity behind it is doing. A page's icon colour, an icon given its own colour, and a lit lamp's own colour each win over this.",
    de: "Worauf eine Taste zurückfällt, eingefärbt danach, was die Entität dahinter gerade tut. Die Symbolfarbe einer Seite, ein Symbol mit eigener Farbe und die Farbe einer eingeschalteten Lampe gehen jeweils vor.",
    fr: "Ce à quoi une touche revient, teinté selon ce que fait l'entité derrière elle. La couleur d'icône d'une page, une icône à la couleur propre et la couleur d'une lampe allumée l'emportent chacune.",
    it: "Ciò a cui un tasto ricade, colorato in base a ciò che fa l'entità dietro di esso. Il colore dell'icona di una pagina, un'icona con un colore proprio e il colore di una luce accesa prevalgono su questo.",
    es: "Aquello a lo que recurre un botón, teñido según lo que hace la entidad detrás de él. El color de icono de una página, un icono con color propio y el color de una lámpara encendida tienen prioridad sobre esto.",
  },
  settings_theme_state_default: {
    en: "Default", de: "Standard", fr: "Par défaut",
    it: "Predefinito", es: "Predeterminado",
  },
  settings_theme_state_on: {
    en: "On", de: "An", fr: "Allumé", it: "Acceso", es: "Encendido",
  },
  settings_theme_state_off: {
    en: "Off", de: "Aus", fr: "Éteint", it: "Spento", es: "Apagado",
  },
  settings_theme_state_unavailable: {
    en: "Unavailable", de: "Nicht verfügbar", fr: "Indisponible",
    it: "Non disponibile", es: "No disponible",
  },
  settings_theme_glyphs_hint: {
    en: "The icon a button falls back to when it names none of its own; an icon set on the button wins. Leave a field empty to keep the built-in one for that state.",
    de: "Das Icon, auf das eine Taste zurückfällt, wenn sie kein eigenes nennt; ein an der Taste gesetztes Icon geht vor. Leer lassen, um das eingebaute für diesen Zustand zu behalten.",
    fr: "L'icône à laquelle une touche revient quand elle n'en nomme aucune ; une icône définie sur la touche l'emporte. Laissez vide pour conserver celle intégrée pour cet état.",
    it: "L'icona a cui un tasto ricade quando non ne indica una propria; un'icona impostata sul tasto prevale. Lascia vuoto per mantenere quella integrata per quello stato.",
    es: "El icono al que recurre un botón cuando no indica ninguno propio; un icono definido en el botón tiene prioridad. Déjalo vacío para mantener el integrado de ese estado.",
  },
  settings_theme_save_failed: {
    en: "The theme could not be saved", de: "Das Design konnte nicht gespeichert werden",
    fr: "Le thème n'a pas pu être enregistré", it: "Il tema non è stato salvato",
    es: "No se pudo guardar el tema",
  },
  settings_theme_colors: {
    en: "Colours", de: "Farben", fr: "Couleurs", it: "Colori", es: "Colores",
  },
  settings_theme_text: {
    en: "Fonts", de: "Schriften", fr: "Polices",
    it: "Caratteri", es: "Fuentes",
  },
  settings_theme_icons: {
    en: "Icons", de: "Icons", fr: "Icônes",
    it: "Icone", es: "Iconos",
  },
  settings_theme_mix: {
    en: "Your earlier mix", de: "Deine frühere Mischung", fr: "Votre ancien mélange",
    it: "La tua vecchia combinazione", es: "Tu mezcla anterior",
  },
  settings_theme_name_missing: {
    en: "Give the theme a name before saving it.",
    de: "Gib dem Theme einen Namen, bevor du es speicherst.",
    fr: "Donnez un nom au thème avant de l'enregistrer.",
    it: "Dai un nome al tema prima di salvarlo.",
    es: "Dale un nombre al tema antes de guardarlo.",
  },
  settings_theme_name_unusable: {
    en: "That name has no letters or numbers to make a file name from.",
    de: "Dieser Name enthält keine Buchstaben oder Ziffern für einen Dateinamen.",
    fr: "Ce nom ne contient ni lettre ni chiffre pour en faire un nom de fichier.",
    it: "Quel nome non ha lettere o numeri da cui ricavare un nome di file.",
    es: "Ese nombre no tiene letras ni números con los que formar un nombre de archivo.",
  },
  settings_theme_name_taken: {
    en: "{name} already goes by this name — pick another, or the two would share one file.",
    de: "{name} heißt bereits so — wähle einen anderen Namen, sonst teilen sich beide eine Datei.",
    fr: "{name} porte déjà ce nom — choisissez-en un autre, sinon les deux partageraient un fichier.",
    it: "{name} si chiama già così — scegline un altro, altrimenti i due condividerebbero un file.",
    es: "{name} ya se llama así — elige otro, o ambos compartirían un archivo.",
  },
  settings_theme_glyph_light_on: {
    en: "A light that's on", de: "Ein eingeschaltetes Licht",
    fr: "Une lumière allumée", it: "Una luce accesa", es: "Una luz encendida",
  },
  settings_theme_glyph_light_off: {
    en: "A light that's off", de: "Ein ausgeschaltetes Licht",
    fr: "Une lumière éteinte", it: "Una luce spenta", es: "Una luz apagada",
  },
  settings_theme_glyph_switch_on: {
    en: "A switch that's on", de: "Ein eingeschalteter Schalter",
    fr: "Un interrupteur allumé", it: "Un interruttore acceso", es: "Un interruptor encendido",
  },
  settings_theme_glyph_switch_off: {
    en: "A switch that's off", de: "Ein ausgeschalteter Schalter",
    fr: "Un interrupteur éteint", it: "Un interruttore spento", es: "Un interruptor apagado",
  },
  settings_theme_glyph_fan_on: {
    en: "A fan that's running", de: "Ein laufender Ventilator",
    fr: "Un ventilateur en marche", it: "Un ventilatore in funzione", es: "Un ventilador en marcha",
  },
  settings_theme_glyph_fan_off: {
    en: "A fan that's stopped", de: "Ein stehender Ventilator",
    fr: "Un ventilateur arrêté", it: "Un ventilatore fermo", es: "Un ventilador parado",
  },
  settings_theme_glyph_lock_locked: {
    en: "A lock that's locked", de: "Ein verriegeltes Schloss",
    fr: "Une serrure verrouillée", it: "Una serratura chiusa", es: "Una cerradura bloqueada",
  },
  settings_theme_glyph_lock_unlocked: {
    en: "A lock that's unlocked", de: "Ein entriegeltes Schloss",
    fr: "Une serrure déverrouillée", it: "Una serratura aperta", es: "Una cerradura desbloqueada",
  },
  settings_sample_title: {
    en: "Living room", de: "Wohnzimmer", fr: "Salon", it: "Soggiorno", es: "Salón",
  },
  settings_sample_tooltip: {
    en: "Lights on", de: "Licht an", fr: "Lumière allumée", it: "Luce accesa", es: "Luz encendida",
  },
  settings_loading: {
    en: "Loading settings…", de: "Einstellungen werden geladen…", fr: "Chargement des paramètres…",
    it: "Caricamento impostazioni…", es: "Cargando ajustes…",
  },
  settings_fonts_hint: {
    en: "To use a font of your own, put its .ttf, .otf, .woff or .woff2 file in {path} and reopen this tab.",
    de: "Für eine eigene Schrift lege die .ttf-, .otf-, .woff- oder .woff2-Datei in {path} ab und öffne diesen Tab erneut.",
    fr: "Pour utiliser votre propre police, placez son fichier .ttf, .otf, .woff ou .woff2 dans {path} et rouvrez cet onglet.",
    it: "Per usare un carattere tuo, metti il file .ttf, .otf, .woff o .woff2 in {path} e riapri questa scheda.",
    es: "Para usar una fuente propia, coloca su archivo .ttf, .otf, .woff u .woff2 en {path} y vuelve a abrir esta pestaña.",
  },
  // NotoColorEmoji.ttf is too large to ship, so colour emoji are opt-in.
  settings_fontbook_failed: {
    en: "Fontbook could not be shown here. Open it on its own:",
    de: "Fontbook konnte hier nicht angezeigt werden. Eigenständig öffnen:",
    fr: "Fontbook n'a pas pu être affiché ici. L'ouvrir à part :",
    it: "Impossibile mostrare Fontbook qui. Aprilo a parte:",
    es: "No se pudo mostrar Fontbook aquí. Ábrelo por separado:",
  },
  settings_emoji_font: {
    en: "Emoji", de: "Emoji", fr: "Emoji", it: "Emoji", es: "Emoji",
  },
  settings_emoji_auto: {
    en: "Automatic", de: "Automatisch", fr: "Automatique", it: "Automatico", es: "Automático",
  },
  settings_emoji_none: {
    en: "None (text font only)", de: "Keine (nur Textschrift)", fr: "Aucune (police du texte seule)",
    it: "Nessuno (solo carattere del testo)", es: "Ninguna (solo la fuente del texto)",
  },
  settings_emoji_hint: {
    en: "Automatic draws emoji with NotoColorEmoji.ttf when it is in {path}, else in black and white; or pick any emoji font you put there.",
    de: "Automatisch zeichnet Emojis mit NotoColorEmoji.ttf, wenn sie in {path} liegt, sonst schwarz-weiß; oder wähle eine Emoji-Schrift, die du dort ablegst.",
    fr: "Automatique dessine les emoji avec NotoColorEmoji.ttf quand elle est dans {path}, sinon en noir et blanc ; ou choisissez une police d'emoji que vous y placez.",
    it: "Automatico disegna le emoji con NotoColorEmoji.ttf se si trova in {path}, altrimenti in bianco e nero; oppure scegli un font emoji che metti lì.",
    es: "Automático dibuja los emojis con NotoColorEmoji.ttf si está en {path}, si no en blanco y negro; o elige una fuente de emojis que pongas allí.",
  },
  add_click_action: {
    en: "Add click action", de: "Klick-Aktion hinzufügen", fr: "Ajouter une action de clic",
    it: "Aggiungi azione clic", es: "Añadir acción de clic",
  },
  add_longtouch_action: {
    en: "Add long-touch action", de: "Aktion für langes Berühren hinzufügen",
    fr: "Ajouter une action d’appui long", it: "Aggiungi azione tocco lungo",
    es: "Añadir acción de toque largo",
  },
  click_action: {
    en: "Click", de: "Klick", fr: "Clic", it: "Clic", es: "Clic",
  },
  settings_key_repeat: {
    en: "Key repeat", de: "Tastenwiederholung",
    fr: "Répétition des touches", it: "Ripetizione dei tasti",
    es: "Repetición de teclas",
  },
  settings_key_repeat_delay: {
    en: "Initial delay", de: "Anfangsverzögerung", fr: "Délai initial",
    it: "Ritardo iniziale", es: "Retraso inicial",
  },
  settings_key_repeat_rate: {
    en: "Rate", de: "Rate", fr: "Fréquence", it: "Frequenza", es: "Frecuencia",
  },
  settings_key_repeat_hint: {
    en: "For buttons with Key repeat on: how long a button is held before it repeats ({delay_min}–{delay_max} ms, default {delay}), then how many presses a second ({rate_min}–{rate_max}, default {rate}).",
    de: "Für Tasten mit Tastenwiederholung: wie lange eine Taste gehalten wird, bevor sie wiederholt ({delay_min}–{delay_max} ms, Standard {delay}), dann wie viele Tastendrücke pro Sekunde ({rate_min}–{rate_max}, Standard {rate}).",
    fr: "Pour les boutons avec la répétition des touches : combien de temps un bouton est maintenu avant de se répéter ({delay_min}–{delay_max} ms, par défaut {delay}), puis combien d'appuis par seconde ({rate_min}–{rate_max}, par défaut {rate}).",
    it: "Per i pulsanti con la ripetizione dei tasti: quanto a lungo un pulsante va tenuto premuto prima che si ripeta ({delay_min}–{delay_max} ms, predefinito {delay}), poi quante pressioni al secondo ({rate_min}–{rate_max}, predefinito {rate}).",
    es: "Para los botones con repetición de teclas: cuánto tiempo se mantiene pulsado un botón antes de repetirse ({delay_min}–{delay_max} ms, por defecto {delay}), y luego cuántas pulsaciones por segundo ({rate_min}–{rate_max}, por defecto {rate}).",
  },
  settings_key_repeat_out_of_range: {
    en: "Enter a whole number from {min} to {max}.",
    de: "Gib eine ganze Zahl von {min} bis {max} ein.",
    fr: "Saisissez un nombre entier de {min} à {max}.",
    it: "Inserisci un numero intero da {min} a {max}.",
    es: "Introduce un número entero de {min} a {max}.",
  },
  unit_ms: { en: "ms", de: "ms", fr: "ms", it: "ms", es: "ms" },
  unit_per_second: {
    en: "per second", de: "pro Sekunde", fr: "par seconde", it: "al secondo", es: "por segundo",
  },
  button_repeat: {
    en: "Key repeat", de: "Tastenwiederholung",
    fr: "Répétition des touches", it: "Ripetizione dei tasti",
    es: "Repetición de teclas",
  },
  button_repeat_hint: {
    en: "Holding the button runs its action again and again, like a TV remote's arrow keys. Delay and rate are in the settings (gear tab).",
    de: "Gedrückt halten führt die Aktion wiederholt aus, wie die Pfeiltasten einer TV-Fernbedienung. Verzögerung und Rate stehen in den Einstellungen (Zahnrad).",
    fr: "Maintenir le bouton relance son action en continu, comme les flèches d'une télécommande TV. Délai et fréquence se règlent dans les paramètres (roue dentée).",
    it: "Tenendo premuto il pulsante, la sua azione si ripete, come i tasti freccia di un telecomando TV. Ritardo e frequenza sono nelle impostazioni (ingranaggio).",
    es: "Mantener pulsado el botón repite su acción, como las flechas de un mando de TV. El retraso y la frecuencia están en los ajustes (engranaje).",
  },
  longtouch_action: {
    en: "Long touch (2 s)", de: "Langes Berühren (2 s)", fr: "Appui long (2 s)",
    it: "Tocco lungo (2 s)", es: "Toque largo (2 s)",
  },
  settings_device: {
    en: "Device", de: "Gerät", fr: "Appareil", it: "Dispositivo", es: "Dispositivo",
  },
  settings_clear_pages: {
    en: "Clear and rebuild pages", de: "Seiten löschen und neu aufbauen",
    fr: "Effacer et reconstruire les pages", it: "Cancella e ricostruisci le pagine",
    es: "Borrar y reconstruir las páginas",
  },
  settings_clear_pages_busy: {
    en: "Rebuilding…", de: "Wird neu aufgebaut…", fr: "Reconstruction…",
    it: "Ricostruzione…", es: "Reconstruyendo…",
  },
  settings_clear_pages_hint: {
    en: "Writes every page on the remote again from this configuration. Use it when the remote no longer shows what you see here. Nothing saved here is lost.",
    de: "Schreibt alle Seiten der Fernbedienung neu aus dieser Konfiguration. Nützlich, wenn die Fernbedienung nicht mehr zeigt, was hier steht. Es geht nichts Gespeichertes verloren.",
    fr: "Réécrit toutes les pages de la télécommande à partir de cette configuration. À utiliser quand la télécommande n’affiche plus ce qui est montré ici. Rien d’enregistré n’est perdu.",
    it: "Riscrive tutte le pagine del telecomando da questa configurazione. Da usare quando il telecomando non mostra più quanto vedi qui. Non si perde nulla di salvato.",
    es: "Vuelve a escribir todas las páginas del mando desde esta configuración. Úsalo cuando el mando ya no muestre lo que ves aquí. No se pierde nada de lo guardado.",
  },
  settings_clear_pages_confirm: {
    en: "Clear every page from the remote and write them back from this configuration?",
    de: "Alle Seiten von der Fernbedienung löschen und aus dieser Konfiguration neu schreiben?",
    fr: "Effacer toutes les pages de la télécommande et les réécrire à partir de cette configuration ?",
    it: "Cancellare tutte le pagine dal telecomando e riscriverle da questa configurazione?",
    es: "¿Borrar todas las páginas del mando y volver a escribirlas desde esta configuración?",
  },
  settings_clear_pages_done: {
    en: "Pages rebuilt", de: "Seiten neu aufgebaut", fr: "Pages reconstruites",
    it: "Pagine ricostruite", es: "Páginas reconstruidas",
  },
  settings_clear_pages_failed: {
    en: "Could not rebuild the pages: {error}",
    de: "Seiten konnten nicht neu aufgebaut werden: {error}",
    fr: "Impossible de reconstruire les pages : {error}",
    it: "Impossibile ricostruire le pagine: {error}",
    es: "No se han podido reconstruir las páginas: {error}",
  },
  // The privacy line, in the progress window. It used to sit on a card in the
  // gear tab; the downloads live in the overflow menu now, and a warning about
  // what a file contains is only useful where the file is being made.
  diagnostics_privacy: {
    en: "The ZIP names the entities your buttons act on, and carries the messages exchanged with the remote. Send it to support rather than posting it publicly.",
    de: "Die ZIP-Datei nennt die Entitäten, die deine Tasten schalten, und enthält die mit der Fernbedienung ausgetauschten Nachrichten. Schick sie an den Support, statt sie öffentlich zu posten.",
    fr: "Le ZIP nomme les entités commandées par vos boutons et contient les messages échangés avec la télécommande. Envoyez-le au support plutôt que de le publier.",
    it: "Lo ZIP nomina le entità comandate dai tuoi pulsanti e contiene i messaggi scambiati con il telecomando. Invialo all'assistenza invece di pubblicarlo.",
    es: "El ZIP nombra las entidades que accionan tus botones y contiene los mensajes intercambiados con el mando. Envíalo al soporte en lugar de publicarlo.",
  },
  // Said beside a menu item whose lane is already building, and in the pill
  // that lane leaves behind.
  diagnostics_menu_running: {
    en: "collecting, {percent}%", de: "wird gesammelt, {percent}%",
    fr: "collecte, {percent}%", it: "raccolta, {percent}%",
    es: "recopilando, {percent}%",
  },
  // The configuration download has no window to report into, so the menu item
  // it was started from is where it says it is working.
  diagnostics_menu_busy: {
    en: "preparing…", de: "wird vorbereitet…", fr: "préparation…",
    it: "in preparazione…", es: "preparando…",
  },
  diagnostics_config_done: {
    en: "Configuration downloaded: {filename}",
    de: "Konfiguration heruntergeladen: {filename}",
    fr: "Configuration téléchargée : {filename}",
    it: "Configurazione scaricata: {filename}",
    es: "Configuración descargada: {filename}",
  },
  diagnostics_done: {
    en: "Diagnostics downloaded: {filename}",
    de: "Diagnose heruntergeladen: {filename}",
    fr: "Diagnostic téléchargé : {filename}",
    it: "Diagnostica scaricata: {filename}",
    es: "Diagnóstico descargado: {filename}",
  },
  diagnostics_done_partial: {
    en: "Diagnostics downloaded: {filename} ({count} part(s) unavailable)",
    de: "Diagnose heruntergeladen: {filename} ({count} Teil(e) nicht verfügbar)",
    fr: "Diagnostic téléchargé : {filename} ({count} partie(s) indisponible(s))",
    it: "Diagnostica scaricata: {filename} ({count} parte/i non disponibile/i)",
    es: "Diagnóstico descargado: {filename} ({count} parte(s) no disponible(s))",
  },
  diagnostics_failed: {
    en: "Could not collect the diagnostics: {error}",
    de: "Diagnose konnte nicht gesammelt werden: {error}",
    fr: "Impossible de collecter le diagnostic : {error}",
    it: "Impossibile raccogliere la diagnostica: {error}",
    es: "No se ha podido recopilar el diagnóstico: {error}",
  },
  // One line per section of the bundle, under the heading it belongs to. The
  // remote alone is most of the wait, so each of its requests is named rather
  // than hidden behind one row that looks stuck.
  diagnostics_group_configuration: {
    en: "Configuration", de: "Konfiguration", fr: "Configuration",
    it: "Configurazione", es: "Configuración",
  },
  diagnostics_group_remote: {
    en: "The remote", de: "Die Fernbedienung", fr: "La télécommande",
    it: "Il telecomando", es: "El mando",
  },
  diagnostics_group_homeassistant: {
    en: "Home Assistant", de: "Home Assistant", fr: "Home Assistant",
    it: "Home Assistant", es: "Home Assistant",
  },
  diagnostics_group_logs: {
    en: "Logs", de: "Protokolle", fr: "Journaux", it: "Log", es: "Registros",
  },
  diagnostics_step_config: {
    en: "Pages and buttons", de: "Seiten und Tasten", fr: "Pages et boutons",
    it: "Pagine e pulsanti", es: "Páginas y botones",
  },
  diagnostics_step_settings: {
    en: "Settings, fonts and icons", de: "Einstellungen, Schriften und Symbole",
    fr: "Réglages, polices et icônes", it: "Impostazioni, caratteri e icone",
    es: "Ajustes, fuentes e iconos",
  },
  diagnostics_step_config_files: {
    en: "Files on disk", de: "Dateien auf der Festplatte",
    fr: "Fichiers sur le disque", it: "File su disco",
    es: "Archivos en disco",
  },
  diagnostics_step_reachability: {
    en: "Checking it answers", de: "Erreichbarkeit wird geprüft",
    fr: "Vérification de la réponse", it: "Verifica della risposta",
    es: "Comprobando si responde",
  },
  diagnostics_step_remote_info: {
    en: "Device info", de: "Geräteinfo", fr: "Infos appareil",
    it: "Info dispositivo", es: "Información del dispositivo",
  },
  diagnostics_step_remote_config_ha: {
    en: "Home Assistant settings", de: "Home-Assistant-Einstellungen",
    fr: "Réglages Home Assistant", it: "Impostazioni Home Assistant",
    es: "Ajustes de Home Assistant",
  },
  diagnostics_step_remote_wifi: {
    en: "Wi-Fi", de: "WLAN", fr: "Wi-Fi", it: "Wi-Fi", es: "Wi-Fi",
  },
  diagnostics_step_remote_status: {
    en: "Status", de: "Status", fr: "État", it: "Stato", es: "Estado",
  },
  diagnostics_step_remote_metrics: {
    en: "Metrics", de: "Messwerte", fr: "Mesures", it: "Metriche", es: "Métricas",
  },
  diagnostics_step_remote_nvm: {
    en: "Memory metrics", de: "Speicherwerte", fr: "Mesures mémoire",
    it: "Metriche di memoria", es: "Métricas de memoria",
  },
  diagnostics_step_remote_logging: {
    en: "Logging setup", de: "Log-Einstellungen",
    fr: "Configuration des journaux", it: "Configurazione dei log",
    es: "Configuración de registro",
  },
  diagnostics_step_remote_logs: {
    en: "Device log", de: "Geräteprotokoll", fr: "Journal de l'appareil",
    it: "Log del dispositivo", es: "Registro del dispositivo",
  },
  diagnostics_step_device: {
    en: "Putting the report together", de: "Bericht wird zusammengestellt",
    fr: "Assemblage du rapport", it: "Composizione del report",
    es: "Componiendo el informe",
  },
  diagnostics_step_diagnostics: {
    en: "Home Assistant's own report", de: "Bericht von Home Assistant",
    fr: "Rapport de Home Assistant", it: "Report di Home Assistant",
    es: "Informe de Home Assistant",
  },
  diagnostics_step_entities: {
    en: "Entities", de: "Entitäten", fr: "Entités", it: "Entità", es: "Entidades",
  },
  diagnostics_step_environment: {
    en: "Versions", de: "Versionen", fr: "Versions", it: "Versioni", es: "Versiones",
  },
  diagnostics_step_ha_log: {
    en: "Home Assistant log", de: "Home-Assistant-Log",
    fr: "Journal Home Assistant", it: "Log di Home Assistant",
    es: "Registro de Home Assistant",
  },
  diagnostics_step_system_log: {
    en: "Errors and warnings", de: "Fehler und Warnungen",
    fr: "Erreurs et avertissements", it: "Errori e avvisi",
    es: "Errores y advertencias",
  },
  diagnostics_step_traffic: {
    en: "Recent messages", de: "Letzte Nachrichten", fr: "Messages récents",
    it: "Messaggi recenti", es: "Mensajes recientes",
  },
  diagnostics_step_packing: {
    en: "Packing the ZIP", de: "ZIP wird gepackt", fr: "Création du ZIP",
    it: "Creazione dello ZIP", es: "Creando el ZIP",
  },
  diagnostics_step_debug: {
    en: "Debug tooling", de: "Debug-Werkzeuge", fr: "Outils de débogage",
    it: "Strumenti di debug", es: "Herramientas de depuración",
  },
  // The overflow menu. Two things can be downloaded, and the difference
  // between them is what they contain -- so each item carries a line saying
  // so rather than leaving the user to find out by opening the ZIP.
  //
  // The ⋮ itself is not named after any one of them: the menu also opens the
  // user guide, and "Download…" on a button that offers something to read is
  // a label that lies.
  overflow_menu: { ha: "ui.common.menu", en: "Menu" },
  user_guide: {
    en: "User guide", de: "Benutzerhandbuch", fr: "Guide de l'utilisateur",
    it: "Guida utente", es: "Guía del usuario",
  },
  guide_open_github: {
    en: "Open on GitHub", de: "Auf GitHub öffnen", fr: "Ouvrir sur GitHub",
    it: "Apri su GitHub", es: "Abrir en GitHub",
  },
  // The control that drops the guide's section list. "Contents" rather than
  // "Table of contents": it is one line of chrome in a narrow column, and the
  // shorter word is the one a reader is listening for.
  guide_contents: {
    en: "Contents", de: "Inhalt", fr: "Sommaire",
    it: "Indice", es: "Contenido",
  },
  // Narrowing twenty sections to the one being looked for -- and, since the
  // guide is forty pages of prose, the words inside them too. Named for the
  // broader job: "Filter sections" promised less than it now does. A search
  // input rather than a text one: the type carries the clear button and the
  // "search" role, and a reader is told what the typing is for.
  guide_filter: {
    en: "Search the guide", de: "Handbuch durchsuchen", fr: "Rechercher dans le guide",
    it: "Cerca nella guida", es: "Buscar en la guía",
  },
  // Said in the list's own place, so the answer to "did I mistype?" is where
  // the eye already is rather than in a toast.
  guide_filter_none: {
    en: "No matching section", de: "Kein passender Abschnitt",
    fr: "Aucune section correspondante", it: "Nessuna sezione corrispondente",
    es: "Ninguna sección coincide",
  },
  // "3 / 17". A position, not just a total: a reader stepping through hits
  // needs to know there are fourteen more and roughly where they are.
  guide_hits: {
    en: "{n} / {total}", de: "{n} / {total}", fr: "{n} / {total}",
    it: "{n} / {total}", es: "{n} / {total}",
  },
  // Spoken for the counter, which on its own is a pair of bare numbers.
  guide_hits_label: {
    en: "Result {n} of {total}", de: "Treffer {n} von {total}",
    fr: "Résultat {n} sur {total}", it: "Risultato {n} di {total}",
    es: "Resultado {n} de {total}",
  },
  // Enter and Shift+Enter do the same thing, but a keystroke nobody is told
  // about is a feature nobody has. The arrows say it out loud.
  guide_hit_next: {
    en: "Next result", de: "Nächster Treffer", fr: "Résultat suivant",
    it: "Risultato successivo", es: "Resultado siguiente",
  },
  guide_hit_prev: {
    en: "Previous result", de: "Vorheriger Treffer", fr: "Résultat précédent",
    it: "Risultato precedente", es: "Resultado anterior",
  },
  // The screenshots, opened full size. A reader comparing two steps walks
  // them with the arrows rather than shutting the picture and scrolling.
  guide_image_next: {
    en: "Next screenshot", de: "Nächster Screenshot", fr: "Capture suivante",
    it: "Schermata successiva", es: "Captura siguiente",
  },
  guide_image_prev: {
    en: "Previous screenshot", de: "Vorheriger Screenshot",
    fr: "Capture précédente", it: "Schermata precedente",
    es: "Captura anterior",
  },
  guide_image_count: {
    en: "Screenshot {n} of {total}", de: "Screenshot {n} von {total}",
    fr: "Capture {n} sur {total}", it: "Schermata {n} di {total}",
    es: "Captura {n} de {total}",
  },
  // The rail costs about 220px of a column that is mostly screenshots, so it
  // folds away. Labelled by what the click will do, not by what is showing:
  // "Hide contents" on a visible rail, "Show contents" on a folded one.
  guide_rail_hide: {
    en: "Hide the contents", de: "Inhalt ausblenden", fr: "Masquer le sommaire",
    it: "Nascondi l'indice", es: "Ocultar el índice",
  },
  guide_rail_show: {
    en: "Show the contents", de: "Inhalt einblenden", fr: "Afficher le sommaire",
    it: "Mostra l'indice", es: "Mostrar el índice",
  },
  // The drag edge between the guide and the configuration. Named for what it
  // does rather than what it is: a reader announcing "separator" has already
  // said what it is, and the arrow keys are what the user needs told.
  guide_resize: {
    en: "Resize the user guide", de: "Breite des Benutzerhandbuchs ändern",
    fr: "Redimensionner le guide d'utilisation",
    it: "Ridimensiona la guida utente", es: "Cambiar el ancho de la guía",
  },
  // Only reachable in a tree where the generated guide module is missing --
  // a checkout where `make guide` has never run. A toast rather than a
  // silent no-op, because a menu item that does nothing reads as a bug in
  // the panel rather than as a gap in the build.
  guide_unavailable: {
    en: "The user guide is not available in this installation.",
    de: "Das Benutzerhandbuch ist in dieser Installation nicht verfügbar.",
    fr: "Le guide de l'utilisateur n'est pas disponible dans cette installation.",
    it: "La guida utente non è disponibile in questa installazione.",
    es: "La guía del usuario no está disponible en esta instalación.",
  },
  diagnostics_scope_standard: {
    en: "Download diagnostics", de: "Diagnose herunterladen",
    fr: "Télécharger le diagnostic", it: "Scarica la diagnostica",
    es: "Descargar diagnóstico",
  },
  diagnostics_scope_config: {
    en: "Download configuration", de: "Konfiguration herunterladen",
    fr: "Télécharger la configuration", it: "Scarica la configurazione",
    es: "Descargar configuración",
  },
  // The progress dialog. It can be put away and brought back, so it says what
  // is happening in the title as well as in the list.
  diagnostics_dialog_running: {
    en: "Collecting diagnostics", de: "Diagnose wird gesammelt",
    fr: "Collecte du diagnostic", it: "Raccolta della diagnostica",
    es: "Recopilando diagnóstico",
  },
  diagnostics_dialog_failed: {
    en: "Collection failed", de: "Sammeln fehlgeschlagen",
    fr: "Échec de la collecte", it: "Raccolta non riuscita",
    es: "Error al recopilar",
  },
  diagnostics_dialog_hint: {
    en: "You can close this window; collecting continues and the download starts on its own.",
    de: "Du kannst dieses Fenster schließen; das Sammeln läuft weiter und der Download startet von selbst.",
    fr: "Vous pouvez fermer cette fenêtre ; la collecte continue et le téléchargement démarre tout seul.",
    it: "Puoi chiudere questa finestra; la raccolta continua e il download parte da solo.",
    es: "Puedes cerrar esta ventana; la recopilación continúa y la descarga empieza sola.",
  },
  diagnostics_hide: {
    en: "Run in background", de: "Im Hintergrund weiterlaufen",
    fr: "Continuer en arrière-plan", it: "Continua in secondo piano",
    es: "Seguir en segundo plano",
  },
  diagnostics_retry: {
    en: "Try again", de: "Erneut versuchen", fr: "Réessayer",
    it: "Riprova", es: "Reintentar",
  },
  diagnostics_reopen: {
    en: "Show progress", de: "Fortschritt anzeigen", fr: "Afficher la progression",
    it: "Mostra avanzamento", es: "Mostrar progreso",
  },
  diagnostics_step_waiting: {
    en: "Waiting", de: "Wartet", fr: "En attente", it: "In attesa", es: "En espera",
  },
  diagnostics_step_running: {
    en: "In progress", de: "Läuft", fr: "En cours", it: "In corso", es: "En curso",
  },
  diagnostics_step_done: {
    en: "Done", de: "Fertig", fr: "Terminé", it: "Fatto", es: "Hecho",
  },
  restore_config: {
    en: "Restore configuration", de: "Konfiguration wiederherstellen",
    fr: "Restaurer la configuration", it: "Ripristina configurazione",
    es: "Restaurar configuración",
  },
  restore_page_buttons: {
    en: "{n} buttons", de: "{n} Tasten", fr: "{n} boutons",
    it: "{n} pulsanti", es: "{n} botones",
  },
  restore_page_buttons_one: {
    en: "1 button", de: "1 Taste", fr: "1 bouton",
    it: "1 pulsante", es: "1 botón",
  },
  restore_pick_file: {
    en: "Choose ZIP file…", de: "ZIP-Datei wählen…", fr: "Choisir le fichier ZIP…",
    it: "Scegli il file ZIP…", es: "Elegir archivo ZIP…",
  },
  restore_drop_hint: {
    en: "or drop the downloaded ZIP here",
    de: "oder die heruntergeladene ZIP hierher ziehen",
    fr: "ou déposez ici le ZIP téléchargé",
    it: "oppure trascina qui lo ZIP scaricato",
    es: "o suelta aquí el ZIP descargado",
  },
  restore_checking: {
    en: "Checking {filename}…", de: "{filename} wird geprüft…",
    fr: "Vérification de {filename}…", it: "Controllo di {filename}…",
    es: "Comprobando {filename}…",
  },
  restore_running: {
    en: "restoring…", de: "wird wiederhergestellt…",
    fr: "restauration…", it: "ripristino…", es: "restaurando…",
  },
  restore_working: {
    en: "Restoring {filename}…", de: "{filename} wird wiederhergestellt…",
    fr: "Restauration de {filename}…", it: "Ripristino di {filename}…",
    es: "Restaurando {filename}…",
  },
  restore_confirm_body: {
    en: "Replaces every page, button and action of this remote.",
    de: "Ersetzt alle Seiten, Tasten und Aktionen dieser Fernbedienung.",
    fr: "Remplace toutes les pages, tous les boutons et toutes les actions de cette télécommande.",
    it: "Sostituisce tutte le pagine, i pulsanti e le azioni di questo telecomando.",
    es: "Sustituye todas las páginas, botones y acciones de este mando.",
  },
  restore_step_choose: {
    en: "Choose", de: "Wählen", fr: "Choisir", it: "Scegli", es: "Elegir",
  },
  restore_step_review: {
    en: "Check", de: "Prüfen", fr: "Vérifier", it: "Verifica", es: "Revisar",
  },
  restore_step_apply: {
    en: "Restore", de: "Wiederherstellen", fr: "Restaurer",
    it: "Ripristina", es: "Restaurar",
  },
  restore_saved_on: {
    en: "Saved {when}", de: "Gespeichert {when}", fr: "Enregistré {when}",
    it: "Salvato {when}", es: "Guardado {when}",
  },
  restore_pages_heading: {
    en: "{pages} pages", de: "{pages} Seiten", fr: "{pages} pages",
    it: "{pages} pagine", es: "{pages} páginas",
  },
  restore_pages_heading_one: {
    en: "1 page", de: "1 Seite", fr: "1 page",
    it: "1 pagina", es: "1 página",
  },
  restore_confirm_action: {
    en: "Restore", de: "Wiederherstellen", fr: "Restaurer",
    it: "Ripristina", es: "Restaurar",
  },
  restore_done: {
    en: "{pages} pages restored.", de: "{pages} Seiten wiederhergestellt.",
    fr: "{pages} pages restaurées.", it: "{pages} pagine ripristinate.",
    es: "{pages} páginas restauradas.",
  },
  restore_done_one: {
    en: "1 page restored.", de: "1 Seite wiederhergestellt.",
    fr: "1 page restaurée.", it: "1 pagina ripristinata.",
    es: "1 página restaurada.",
  },
  restore_failed: {
    en: "Restore failed: {error}", de: "Wiederherstellen fehlgeschlagen: {error}",
    fr: "Échec de la restauration : {error}", it: "Ripristino non riuscito: {error}",
    es: "Error al restaurar: {error}",
  },
  restore_error_not_a_zip: {
    en: "That file is not a ZIP archive.", de: "Diese Datei ist kein ZIP-Archiv.",
    fr: "Ce fichier n’est pas une archive ZIP.", it: "Questo file non è un archivio ZIP.",
    es: "Ese archivo no es un archivo ZIP.",
  },
  restore_error_not_lizaip: {
    en: "That archive is not a lizaIP configuration.",
    de: "Dieses Archiv ist keine lizaIP-Konfiguration.",
    fr: "Cette archive n’est pas une configuration lizaIP.",
    it: "Questo archivio non è una configurazione lizaIP.",
    es: "Ese archivo no es una configuración lizaIP.",
  },
  restore_error_no_config: {
    en: "That archive holds no configuration files.",
    de: "Dieses Archiv enthält keine Konfigurationsdateien.",
    fr: "Cette archive ne contient aucun fichier de configuration.",
    it: "Questo archivio non contiene file di configurazione.",
    es: "Ese archivo no contiene archivos de configuración.",
  },
  restore_error_bad_yaml: {
    en: "A file in that archive is damaged, so nothing was changed.",
    de: "Eine Datei in diesem Archiv ist beschädigt, daher wurde nichts geändert.",
    fr: "Un fichier de cette archive est endommagé ; rien n’a été modifié.",
    it: "Un file dell’archivio è danneggiato, quindi non è stato cambiato nulla.",
    es: "Un archivo del paquete está dañado, así que no se cambió nada.",
  },
  restore_error_bad_page: {
    en: "A page in that archive cannot be read, so nothing was changed.",
    de: "Eine Seite in diesem Archiv kann nicht gelesen werden, daher wurde nichts geändert.",
    fr: "Une page de cette archive est illisible ; rien n’a été modifié.",
    it: "Una pagina dell’archivio non è leggibile, quindi non è stato cambiato nulla.",
    es: "Una página del archivo no se puede leer, así que no se cambió nada.",
  },
  restore_error_unsafe_path: {
    en: "That archive holds file paths that are not allowed.",
    de: "Dieses Archiv enthält unzulässige Dateipfade.",
    fr: "Cette archive contient des chemins de fichiers non autorisés.",
    it: "Questo archivio contiene percorsi di file non consentiti.",
    es: "Ese archivo contiene rutas de archivo no permitidas.",
  },
  restore_error_too_large: {
    en: "That archive is too large.", de: "Dieses Archiv ist zu groß.",
    fr: "Cette archive est trop volumineuse.", it: "Questo archivio è troppo grande.",
    es: "Ese archivo es demasiado grande.",
  },
  restore_error_expired: {
    en: "The upload expired. Choose the file again.",
    de: "Der Upload ist abgelaufen. Bitte die Datei erneut auswählen.",
    fr: "Le téléversement a expiré. Choisissez à nouveau le fichier.",
    it: "Il caricamento è scaduto. Seleziona di nuovo il file.",
    es: "La subida ha caducado. Elige el archivo de nuevo.",
  },
  settings_buttons: {
    en: "Buttons", de: "Tasten", fr: "Boutons", it: "Pulsanti", es: "Botones",
  },
  settings_longtouch: {
    en: "Long touch", de: "Langes Berühren", fr: "Appui long", it: "Tocco lungo", es: "Toque largo",
  },
  settings_longtouch_hint: {
    en: "Resting a finger on a button for 2 seconds runs its long-touch action. On buttons that have one, the click runs when the finger lifts.",
    de: "Bleibt ein Finger 2 Sekunden auf einer Taste, läuft ihre Aktion für langes Berühren. Bei Tasten mit einer solchen Aktion läuft der Klick erst beim Loslassen.",
    fr: "Laisser le doigt 2 secondes sur un bouton lance son action d’appui long. Sur les boutons qui en ont une, le clic part au moment où le doigt se lève.",
    it: "Tenere il dito su un pulsante per 2 secondi esegue la sua azione di tocco lungo. Sui pulsanti che ne hanno una, il clic parte quando si solleva il dito.",
    es: "Mantener el dedo 2 segundos sobre un botón ejecuta su acción de toque largo. En los botones que tienen una, el clic se ejecuta al levantar el dedo.",
  },
  // Named for what it builds -- a button that carries several actions -- and
  // not for the word on the section it adds. "Toggle" alone read as the
  // `toggle` service, which every lamp button already runs.
  settings_toggle: {
    en: "Multi toggle button", de: "Mehrfach-Umschalttaste",
    fr: "Bouton à bascule multiple", it: "Pulsante a commutazione multipla",
    es: "Botón de conmutación múltiple",
  },
  settings_toggle_hint: {
    en: "Lets a button carry several actions and step through them, one per press. Adds a Multi toggle button section to every grid button. Switching this off leaves the steps stored but makes those buttons run their normal action again.",
    de: "Lässt eine Taste mehrere Aktionen tragen und bei jedem Druck zur nächsten springen. Fügt jeder Rastertaste einen Bereich „Mehrfach-Umschalttaste“ hinzu. Beim Ausschalten bleiben die Schritte gespeichert, die Tasten führen aber wieder ihre normale Aktion aus.",
    fr: "Permet à un bouton de porter plusieurs actions et de passer à la suivante à chaque appui. Ajoute une section Bouton à bascule multiple à chaque bouton de la grille. En désactivant, les étapes restent enregistrées mais ces boutons relancent leur action normale.",
    it: "Consente a un pulsante di contenere più azioni e di passare alla successiva a ogni pressione. Aggiunge una sezione Pulsante a commutazione multipla a ogni pulsante della griglia. Disattivandola i passaggi restano salvati, ma i pulsanti tornano a eseguire la loro azione normale.",
    es: "Permite que un botón lleve varias acciones y avance a la siguiente en cada pulsación. Añade una sección Botón de conmutación múltiple a cada botón de la cuadrícula. Al desactivarlo los pasos siguen guardados, pero esos botones vuelven a ejecutar su acción normal.",
  },
  settings_options: {
    en: "Options pages", de: "Optionsseiten", fr: "Pages d’options",
    it: "Pagine di opzioni", es: "Páginas de opciones",
  },
  settings_options_hint: {
    en: "Adds Add options… to a button’s menu when an options template fits its device: a page of settings for that device, opened by the button’s long touch. Needs Long touch. Switching this off keeps the options pages already made.",
    de: "Fügt dem Menü einer Taste „Optionen hinzufügen…“ hinzu, wenn eine Optionsvorlage zu ihrem Gerät passt: eine Seite mit Einstellungen für dieses Gerät, die das lange Berühren der Taste öffnet. Benötigt „Langes Berühren“. Beim Ausschalten bleiben bereits angelegte Optionsseiten erhalten.",
    fr: "Ajoute Ajouter des options… au menu d’un bouton quand un modèle d’options convient à son appareil : une page de réglages pour cet appareil, ouverte par l’appui long du bouton. Nécessite Appui long. En désactivant, les pages d’options déjà créées sont conservées.",
    it: "Aggiunge Aggiungi opzioni… al menu di un pulsante quando un modello di opzioni è adatto al suo dispositivo: una pagina di impostazioni per quel dispositivo, aperta dal tocco lungo del pulsante. Richiede Tocco lungo. Disattivandola, le pagine di opzioni già create restano.",
    es: "Añade Añadir opciones… al menú de un botón cuando una plantilla de opciones encaja con su dispositivo: una página de ajustes para ese dispositivo, que abre el toque largo del botón. Requiere Toque largo. Al desactivarlo se conservan las páginas de opciones ya creadas.",
  },
  settings_memory_card: {
    en: "Device memory", de: "Gerätespeicher",
    fr: "Mémoire de l’appareil", it: "Memoria del dispositivo",
    es: "Memoria del dispositivo",
  },
  settings_memory: {
    en: "Show memory use", de: "Speicherauslastung anzeigen",
    fr: "Afficher l’utilisation de la mémoire", it: "Mostra l’uso della memoria",
    es: "Mostrar el uso de memoria",
  },
  settings_memory_hint: {
    en: "Shows bars next to the device name for RAM, heap fragmentation and flash. Read from the device after every transfer and at least every 5 minutes.", de: "Zeigt neben dem Gerätenamen Balken für RAM, Heap-Fragmentierung und Flash. Wird nach jeder Übertragung zum Gerät und mindestens alle 5 Minuten aktualisiert.",
    fr: "Affiche à côté du nom de l’appareil des barres pour la RAM, la fragmentation du tas et la flash. Mis à jour après chaque transfert vers l’appareil et au moins toutes les 5 minutes.", it: "Mostra accanto al nome del dispositivo barre per RAM, frammentazione dell’heap e flash. Aggiornato dopo ogni trasferimento al dispositivo e almeno ogni 5 minuti.",
    es: "Muestra junto al nombre del dispositivo barras de RAM, fragmentación del heap y flash. Se actualiza tras cada transferencia al dispositivo y al menos cada 5 minutos.",
  },
  memory_group: {
    en: "Device memory", de: "Gerätespeicher",
    fr: "Mémoire de l’appareil", it: "Memoria del dispositivo",
    es: "Memoria del dispositivo",
  },
  memory_ram: {
    en: "RAM", de: "RAM",
    fr: "RAM", it: "RAM",
    es: "RAM",
  },
  memory_frag: {
    en: "Frag.", de: "Frag.",
    fr: "Frag.", it: "Framm.",
    es: "Frag.",
  },
  memory_flash_images: {
    en: "Flash images", de: "Flash Bilder",
    fr: "Flash images", it: "Flash immagini",
    es: "Flash imágenes",
  },
  memory_flash_files: {
    en: "Flash files", de: "Flash Dateien",
    fr: "Flash fichiers", it: "Flash file",
    es: "Flash archivos",
  },
  memory_used_of: {
    en: "{used} of {total} used", de: "{used} von {total} belegt",
    fr: "{used} sur {total} utilisés", it: "{used} di {total} usati",
    es: "{used} de {total} usados",
  },
  memory_unknown: {
    en: "not read yet — the device did not report it", de: "noch nicht gelesen — das Gerät hat es nicht gemeldet",
    fr: "pas encore lu — l’appareil ne l’a pas signalé", it: "non ancora letto — il dispositivo non l’ha segnalato",
    es: "aún no leído — el dispositivo no lo ha informado",
  },
  memory_frag_tip: {
    en: "Heap fragmentation: largest free block {largest} of {free} free", de: "Heap-Fragmentierung: größter freier Block {largest} von {free} frei",
    fr: "Fragmentation du tas : plus grand bloc libre {largest} sur {free} libres", it: "Frammentazione heap: blocco libero più grande {largest} su {free} liberi",
    es: "Fragmentación del heap: bloque libre mayor {largest} de {free} libres",
  },
  settings_page_links: {
    en: "Show page links",
    de: "Seitenverbindungen anzeigen",
    fr: "Afficher les liens entre pages",
    it: "Mostra i collegamenti tra pagine",
    es: "Mostrar enlaces entre páginas",
  },
  settings_page_links_hint: {
    en: "While the pointer rests on a button, draws a line to the page that button opens. Resting it on a page instead draws every link that reaches that page.",
    de: "Steht der Zeiger auf einer Taste, wird eine Linie zu der Seite gezeichnet, die sie öffnet. Steht er stattdessen auf einer Seite, werden alle Verbindungen gezeichnet, die auf diese Seite führen.",
    fr: "Tant que le pointeur repose sur un bouton, trace une ligne vers la page qu'il ouvre. S'il repose sur une page, trace tous les liens qui mènent à cette page.",
    it: "Finché il puntatore resta su un pulsante, traccia una linea verso la pagina che apre. Se resta su una pagina, traccia tutti i collegamenti che la raggiungono.",
    es: "Mientras el puntero descansa sobre un botón, dibuja una línea hasta la página que abre. Si descansa sobre una página, dibuja todos los enlaces que llegan a ella.",
  },

  settings_icons: {
    en: "Icon options", de: "Symbol-Optionen", fr: "Options d'icône", it: "Opzioni icona", es: "Opciones de icono",
  },
  // The gear tab's chip row and the four pages behind it.
  settings_groups: {
    en: "Settings sections", de: "Einstellungsbereiche", fr: "Sections des réglages",
    it: "Sezioni delle impostazioni", es: "Secciones de ajustes",
  },
  settings_group_appearance: {
    en: "Appearance", de: "Darstellung", fr: "Apparence", it: "Aspetto", es: "Apariencia",
  },
  settings_group_behaviour: {
    en: "Behaviour", de: "Verhalten", fr: "Comportement", it: "Comportamento", es: "Comportamiento",
  },
  settings_editor: {
    en: "This editor", de: "Dieser Editor", fr: "Cet éditeur", it: "Questo editor", es: "Este editor",
  },
  settings_group_editor: {
    en: "Editor", de: "Editor", fr: "Éditeur", it: "Editor", es: "Editor",
  },
  settings_search_placeholder: {
    en: "Search settings", de: "Einstellungen durchsuchen", fr: "Rechercher dans les réglages",
    it: "Cerca nelle impostazioni", es: "Buscar ajustes",
  },
  settings_search_results: {
    en: "Search results ({count})", de: "Suchergebnisse ({count})", fr: "Résultats ({count})",
    it: "Risultati ({count})", es: "Resultados ({count})",
  },
  settings_search_note: {
    en: "From every section at once. Clear the box, or pick a section above, to go back.",
    de: "Aus allen Bereichen zugleich. Leere das Feld oder wähle oben einen Bereich, um zurückzukehren.",
    fr: "De toutes les sections à la fois. Videz le champ, ou choisissez une section ci-dessus, pour revenir.",
    it: "Da tutte le sezioni insieme. Svuota il campo, o scegli una sezione sopra, per tornare.",
    es: "De todas las secciones a la vez. Vacía el campo, o elige una sección arriba, para volver.",
  },
  settings_search_none: {
    en: "No setting here mentions \u201c{query}\u201d.",
    de: "Keine Einstellung hier erwähnt \u201e{query}\u201c.",
    fr: "Aucun réglage ici ne mentionne «\u00a0{query}\u00a0».",
    it: "Nessuna impostazione qui menziona \u201c{query}\u201d.",
    es: "Ningún ajuste aquí menciona \u201c{query}\u201d.",
  },
  settings_key_repeat_demo: {
    en: "Press and hold", de: "Gedrückt halten", fr: "Appuyer et maintenir",
    it: "Tieni premuto", es: "Mantén pulsado",
  },
  settings_key_repeat_demo_hint: {
    en: "Try the wait and the speed set above. Nothing is sent to the remote.",
    de: "Probiere die oben eingestellte Wartezeit und Geschwindigkeit aus. An die Fernbedienung geht nichts.",
    fr: "Essayez le délai et la vitesse réglés ci-dessus. Rien n'est envoyé à la télécommande.",
    it: "Prova l'attesa e la velocità impostate sopra. Al telecomando non viene inviato nulla.",
    es: "Prueba la espera y la velocidad definidas arriba. No se envía nada al mando.",
  },
  settings_variables_sample_value: {
    en: "21.4 °C", de: "21,4 °C", fr: "21,4 °C", it: "21,4 °C", es: "21,4 °C",
  },
  settings_variables: {
    en: "Variables", de: "Variablen", fr: "Variables", it: "Variabili", es: "Variables",
  },
  settings_variables_interval: {
    en: "Update interval", de: "Aktualisierungsintervall", fr: "Intervalle de mise à jour",
    it: "Intervallo di aggiornamento", es: "Intervalo de actualización",
  },
  settings_variables_interval_hint: {
    en: "A value that changes once is sent straight away. One that keeps changing — a lamp being dimmed, say — is sent at most this often. From {min} to {max}, {default} by default.",
    de: "Ein Wert, der sich einmal ändert, wird sofort gesendet. Einer, der sich laufend ändert — etwa eine Lampe beim Dimmen —, höchstens so oft. Von {min} bis {max}, standardmäßig {default}.",
    fr: "Une valeur qui change une fois est envoyée aussitôt. Une valeur qui change sans cesse — une lampe en cours de variation, par exemple — est envoyée au plus à ce rythme. De {min} à {max}, {default} par défaut.",
    it: "Un valore che cambia una volta viene inviato subito. Uno che cambia di continuo — una luce che si regola, per esempio — al massimo con questa frequenza. Da {min} a {max}, {default} come predefinito.",
    es: "Un valor que cambia una vez se envía al instante. Uno que cambia sin parar — una lámpara que se regula, por ejemplo — se envía como mucho con esta frecuencia. De {min} a {max}, {default} por defecto.",
  },
  settings_icon_color_enabled: {
    en: "Tint icons with the light's colour",
    de: "Symbole in der Lampenfarbe einfärben",
    fr: "Teinter les icônes avec la couleur de la lampe",
    it: "Colora le icone con il colore della luce",
    es: "Tintar los iconos con el color de la luz",
  },
  settings_icon_color_enabled_hint: {
    en: "On the remote, a button bound to a lit lamp takes that lamp's colour instead of the page colour.",
    de: "Auf der Fernbedienung übernimmt eine Taste, die einer eingeschalteten Lampe zugeordnet ist, deren Farbe statt der Seitenfarbe.",
    fr: "Sur la télécommande, un bouton associé à une lampe allumée prend la couleur de cette lampe au lieu de celle de la page.",
    it: "Sul telecomando, un pulsante associato a una luce accesa assume il colore di quella luce invece di quello della pagina.",
    es: "En el mando, un botón asociado a una lámpara encendida toma el color de esa lámpara en lugar del de la página.",
  },
  settings_icon_fill_enabled: {
    en: "Fill icons with the light's brightness",
    de: "Symbole nach Helligkeit füllen",
    fr: "Remplir les icônes selon la luminosité",
    it: "Riempi le icone in base alla luminosità",
    es: "Rellenar los iconos según el brillo",
  },
  settings_icon_fill_enabled_hint: {
    en: "On the remote, fills the icon from the bottom, like a gauge. Independent of the tint above.",
    de: "Füllt das Symbol auf der Fernbedienung von unten wie eine Anzeige. Unabhängig von der Einfärbung darüber.",
    fr: "Sur la télécommande, remplit l'icône par le bas, comme une jauge. Indépendant de la teinte ci-dessus.",
    it: "Sul telecomando, riempie l'icona dal basso, come un indicatore. Indipendente dalla colorazione sopra.",
    es: "En el mando, rellena el icono desde abajo, como un indicador. Independiente del tinte de arriba.",
  },
  settings_fill_step: {
    en: "Fill step", de: "Füllschritt", fr: "Pas de remplissage", it: "Passo di riempimento", es: "Paso de relleno",
  },
  settings_fill_step_hint: {
    en: "From {min} to {max}. Smaller is smoother; larger makes dimming feel quicker, since the remote fetches a new image for every fill level.",
    de: "Von {min} bis {max}. Kleiner ist flüssiger; größer lässt das Dimmen schneller wirken, da die Fernbedienung für jede Füllstufe ein neues Bild lädt.",
    fr: "De {min} à {max}. Plus petit est plus fluide ; plus grand rend la variation plus réactive, car la télécommande charge une nouvelle image pour chaque niveau.",
    it: "Da {min} a {max}. Più piccolo è più fluido; più grande rende la regolazione più reattiva, perché il telecomando scarica una nuova immagine per ogni livello.",
    es: "De {min} a {max}. Más pequeño es más suave; más grande hace que la regulación se sienta más rápida, ya que el mando descarga una imagen nueva por cada nivel.",
  },
  settings_corner_radius: {
    en: "Corner radius", de: "Eckenradius", fr: "Rayon des coins", it: "Raggio degli angoli", es: "Radio de las esquinas",
  },
  settings_corner_radius_hint: {
    en: "From {min} % (square) to {max} % (round). Applies to whole pictures such as covers; pictures cut into a grid stay square.",
    de: "Von {min} % (eckig) bis {max} % (rund). Gilt für ganze Bilder wie Cover; in ein Raster zerschnittene Bilder bleiben eckig.",
    fr: "De {min} % (carré) à {max} % (rond). S'applique aux images entières comme les pochettes ; les images découpées en grille restent carrées.",
    it: "Da {min} % (quadrato) a {max} % (tondo). Vale per le immagini intere, come le copertine; quelle divise in griglia restano quadrate.",
    es: "De {min} % (cuadrado) a {max} % (redondo). Se aplica a imágenes completas, como las carátulas; las cortadas en cuadrícula siguen cuadradas.",
  },
  settings_saved: {
    en: "Settings saved. The remote redraws its pages.",
    de: "Einstellungen gespeichert. Die Fernbedienung zeichnet ihre Seiten neu.",
    fr: "Paramètres enregistrés. La télécommande redessine ses pages.",
    it: "Impostazioni salvate. Il telecomando ridisegna le sue pagine.",
    es: "Ajustes guardados. El mando vuelve a dibujar sus páginas.",
  },
  settings_save_failed: {
    en: "Saving failed: {error}", de: "Speichern fehlgeschlagen: {error}", fr: "Échec de l'enregistrement : {error}",
    it: "Salvataggio non riuscito: {error}", es: "Error al guardar: {error}",
  },

  // ── debug tab ──────────────────────────────────────────────────────
  // Only reachable on a build that carries the debug tooling; the strings
  // stay here regardless, because the i18n table is shipped whole and one
  // missing key would render as its own name.
  tab_debug: {
    en: "Debug", de: "Diagnose", fr: "Diagnostic", it: "Diagnostica", es: "Diagnóstico",
  },
  // Rejections from `hass.callWS` that arrive as a bare numeric code rather
  // than an error object -- see `_wsErrorText`. Worded as what the user can do
  // about it, because the code itself tells them nothing.
  ws_err_cannot_connect: {
    en: "No connection to Home Assistant.",
    de: "Keine Verbindung zu Home Assistant.",
    fr: "Pas de connexion à Home Assistant.",
    it: "Nessuna connessione a Home Assistant.",
    es: "Sin conexión con Home Assistant.",
  },
  ws_err_invalid_auth: {
    en: "Not signed in to Home Assistant any more — reload the page.",
    de: "Nicht mehr bei Home Assistant angemeldet — Seite neu laden.",
    fr: "Vous n'êtes plus connecté à Home Assistant — rechargez la page.",
    it: "Non più autenticato in Home Assistant: ricarica la pagina.",
    es: "Ya no hay sesión iniciada en Home Assistant: recarga la página.",
  },
  ws_err_connection_lost: {
    en: "Connection to Home Assistant lost before an answer arrived — try again.",
    de: "Verbindung zu Home Assistant ging verloren, bevor eine Antwort kam — bitte erneut versuchen.",
    fr: "Connexion à Home Assistant perdue avant la réponse — réessayez.",
    it: "Connessione a Home Assistant persa prima della risposta: riprova.",
    es: "Se perdió la conexión con Home Assistant antes de la respuesta: inténtalo de nuevo.",
  },
  ws_err_host_required: {
    en: "No Home Assistant address configured.",
    de: "Keine Home-Assistant-Adresse konfiguriert.",
    fr: "Aucune adresse Home Assistant configurée.",
    it: "Nessun indirizzo Home Assistant configurato.",
    es: "No hay ninguna dirección de Home Assistant configurada.",
  },
  ws_err_https_to_http: {
    en: "A secure page cannot reach Home Assistant over plain HTTP.",
    de: "Eine sichere Seite kann Home Assistant nicht über unverschlüsseltes HTTP erreichen.",
    fr: "Une page sécurisée ne peut pas joindre Home Assistant en HTTP simple.",
    it: "Una pagina sicura non può raggiungere Home Assistant via HTTP non cifrato.",
    es: "Una página segura no puede acceder a Home Assistant por HTTP sin cifrar.",
  },
  ws_err_auth_callback: {
    en: "Sign-in to Home Assistant did not complete.",
    de: "Die Anmeldung bei Home Assistant wurde nicht abgeschlossen.",
    fr: "La connexion à Home Assistant ne s'est pas terminée.",
    it: "L'accesso a Home Assistant non è stato completato.",
    es: "El inicio de sesión en Home Assistant no se completó.",
  },
  debug_reachability: {
    en: "Reachability", de: "Erreichbarkeit", fr: "Accessibilité",
    it: "Raggiungibilità", es: "Accesibilidad",
  },
  debug_not_tested: {
    en: "Not tested yet.", de: "Noch nicht getestet.", fr: "Pas encore testé.",
    it: "Non ancora testato.", es: "Aún sin probar.",
  },
  debug_ping: {
    en: "Ping", de: "Anpingen", fr: "Envoyer un ping",
    it: "Esegui ping", es: "Hacer ping",
  },
  debug_pinging: {
    en: "Pinging…", de: "Wird angepingt…", fr: "Ping en cours…",
    it: "Ping in corso…", es: "Haciendo ping…",
  },
  debug_never_connected: {
    en: "The remote has never connected, so there is no address to test.",
    de: "Die Fernbedienung hat sich noch nie verbunden, daher gibt es keine Adresse zum Testen.",
    fr: "La télécommande ne s'est jamais connectée, il n'y a donc aucune adresse à tester.",
    it: "Il telecomando non si è mai connesso, quindi non c'è alcun indirizzo da testare.",
    es: "El mando nunca se ha conectado, por lo que no hay dirección que probar.",
  },
  debug_reachable: {
    en: "Reachable", de: "Erreichbar", fr: "Accessible",
    it: "Raggiungibile", es: "Accesible",
  },
  debug_unreachable: {
    en: "Not reachable", de: "Nicht erreichbar", fr: "Inaccessible",
    it: "Non raggiungibile", es: "No accesible",
  },
  debug_address: {
    en: "Address", de: "Adresse", fr: "Adresse", it: "Indirizzo", es: "Dirección",
  },
  debug_latency: {
    en: "Response time", de: "Antwortzeit", fr: "Temps de réponse",
    it: "Tempo di risposta", es: "Tiempo de respuesta",
  },
  debug_error: {
    en: "Error", de: "Fehler", fr: "Erreur", it: "Errore", es: "Error",
  },
  debug_websocket: {
    en: "WebSocket", de: "WebSocket", fr: "WebSocket", it: "WebSocket", es: "WebSocket",
  },
  debug_connected: {
    en: "Connected", de: "Verbunden", fr: "Connecté", it: "Connesso", es: "Conectado",
  },
  debug_disconnected: {
    en: "Disconnected", de: "Getrennt", fr: "Déconnecté",
    it: "Disconnesso", es: "Desconectado",
  },
  debug_log_port: {
    en: "Device log stream", de: "Geräteprotokoll-Stream", fr: "Flux de journal de l'appareil",
    it: "Flusso di log del dispositivo", es: "Flujo de registro del dispositivo",
  },
  debug_log_port_hint: {
    en: "Opens the remote's debug port and writes its output to the Home Assistant log at debug level. Turn it off again when you are done — it is not kept across restarts.",
    de: "Öffnet den Debug-Port der Fernbedienung und schreibt deren Ausgabe auf Debug-Ebene ins Home-Assistant-Protokoll. Danach wieder ausschalten — die Einstellung übersteht keinen Neustart.",
    fr: "Ouvre le port de débogage de la télécommande et écrit sa sortie dans le journal Home Assistant au niveau debug. Désactivez-le ensuite : il n'est pas conservé après un redémarrage.",
    it: "Apre la porta di debug del telecomando e scrive il suo output nel log di Home Assistant a livello debug. Disattivalo quando hai finito: non viene mantenuto dopo un riavvio.",
    es: "Abre el puerto de depuración del mando y escribe su salida en el registro de Home Assistant en nivel debug. Desactívalo al terminar: no se conserva tras un reinicio.",
  },
  // A switch reports a state, where a button named an action. "Disable" on a
  // control that is already off read as the thing it would do, which is the
  // opposite of what a switch means.
  debug_stream_on: {
    en: "On", de: "Ein", fr: "Activé", it: "Attivo", es: "Activado",
  },
  debug_stream_off: {
    en: "Off", de: "Aus", fr: "Désactivé", it: "Disattivo", es: "Desactivado",
  },
  // Shown only while the stream is running. The lines do not appear in the
  // panel -- they go into Home Assistant's own log -- so without this the
  // switch would look like it had done nothing.
  //
  // The second sentence is not padding. That page opens on the grouped list fed
  // by the system_log integration, whose handler sits at WARNING, so these
  // DEBUG lines can never appear there. Only the raw view renders them, and it
  // is reached by a button: ha-config-logs keeps that choice in internal state,
  // never in the URL, so the link cannot land on it and the reader has to be
  // told. The button is named through Home Assistant's own string, so it reads
  // exactly as this instance labels it rather than as a guess of ours.
  debug_stream_live: {
    en: "The device's lines are being written to {link}. That page opens on the "
      + "grouped warnings and errors, where these lines never appear — use "
      + "\u201c{button}\u201d to see them.",
    de: "Die Zeilen des Geräts werden nach {link} geschrieben. Diese Seite "
      + "öffnet zuerst die gruppierten Warnungen und Fehler, in denen diese "
      + "Zeilen nie auftauchen — mit \u201e{button}\u201c werden sie sichtbar.",
    fr: "Les lignes de l'appareil sont écrites dans {link}. Cette page s'ouvre "
      + "sur les avertissements et erreurs groupés, où ces lignes n'apparaissent "
      + "jamais — utilisez «\u202f{button}\u202f» pour les voir.",
    it: "Le righe del dispositivo vengono scritte in {link}. Quella pagina si "
      + "apre sugli avvisi e sugli errori raggruppati, dove queste righe non "
      + "compaiono mai: usa \u201c{button}\u201d per vederle.",
    es: "Las líneas del dispositivo se escriben en {link}. Esa página se abre "
      + "en las advertencias y los errores agrupados, donde estas líneas nunca "
      + "aparecen: usa \u201c{button}\u201d para verlas.",
  },
  // Home Assistant's own label for the button that switches the log page to the
  // raw view. Taking it from its string means the hint names what the reader
  // actually sees, in whatever language the instance runs -- which is also why
  // only English is carried here: the instance supplies the rest, and a second
  // set of our own could only contradict it.
  debug_stream_raw_button: {
    ha: "ui.panel.config.logs.show_full_logs", en: "Show raw logs",
  },
  // Shown when the device's port is open but nothing is reading it -- the
  // state a restart of Home Assistant leaves behind, since the port survives
  // it and the task reading the port does not.
  debug_stream_detached: {
    en: "The port is open on the device, but these lines are not being "
      + "collected. Switch it off and on again to start reading it.",
    de: "Der Port am Gerät ist offen, aber die Zeilen werden nicht "
      + "eingesammelt. Zum Mitlesen den Schalter aus- und wieder einschalten.",
    fr: "Le port est ouvert sur l'appareil, mais ces lignes ne sont pas "
      + "collectées. Éteignez puis rallumez l'interrupteur pour les lire.",
    it: "La porta è aperta sul dispositivo, ma queste righe non vengono "
      + "raccolte. Spegni e riaccendi l'interruttore per leggerle.",
    es: "El puerto está abierto en el dispositivo, pero estas líneas no se "
      + "recogen. Apaga y vuelve a encender el interruptor para leerlas.",
  },
  // The read failed without saying why. The switch keeps showing what it last
  // knew rather than claiming the port is closed.
  debug_port_unknown: {
    en: "Could not read the port's state from the device.",
    de: "Der Zustand des Ports konnte nicht vom Gerät gelesen werden.",
    fr: "Impossible de lire l'état du port depuis l'appareil.",
    it: "Impossibile leggere lo stato della porta dal dispositivo.",
    es: "No se pudo leer el estado del puerto desde el dispositivo.",
  },
  debug_stream_live_link: {
    en: "the Home Assistant log", de: "das Home-Assistant-Protokoll",
    fr: "le journal Home Assistant", it: "il registro di Home Assistant",
    es: "el registro de Home Assistant",
  },
  // The per-module log levels. The level names themselves are not translated:
  // they are the values the device takes, and a translated "off" sent back
  // would be refused. They are shown as the device spells them.
  debug_logging: {
    en: "Log levels", de: "Protokollstufen", fr: "Niveaux de journalisation",
    it: "Livelli di log", es: "Niveles de registro",
  },
  debug_logging_hint: {
    en: "Which parts of the remote's firmware write to its log, and how much.",
    de: "Welche Teile der Firmware der Fernbedienung protokollieren und wie ausführlich.",
    fr: "Quelles parties du micrologiciel de la télécommande écrivent dans son journal, et à quel point.",
    it: "Quali parti del firmware del telecomando scrivono nel suo log e con quanto dettaglio.",
    es: "Qué partes del firmware del mando escriben en su registro y con cuánto detalle.",
  },
  debug_logging_loading: {
    en: "Reading…", de: "Wird gelesen…", fr: "Lecture…",
    it: "Lettura…", es: "Leyendo…",
  },
  // The two states of the per-section button: the label says what a click
  // will do, not what is currently shown.
  debug_pretty: {
    en: "Pretty", de: "Formatiert", fr: "Format\u00e9", it: "Formattato",
    es: "Formateado",
  },
  debug_raw: {
    en: "Raw", de: "Roh", fr: "Brut", it: "Grezzo", es: "Sin formato",
  },
  debug_logging_reset: {
    en: "Reset all to important", de: "Alle auf \u201eimportant\u201c zur\u00fccksetzen",
    fr: "Tout remettre sur \u00ab\u202fimportant\u202f\u00bb",
    it: "Reimposta tutto su \u201cimportant\u201d",
    es: "Restablecer todo a \u201cimportant\u201d",
  },
  debug_logging_empty: {
    en: "The remote did not report any log modules.",
    de: "Die Fernbedienung hat keine Protokollmodule gemeldet.",
    fr: "La télécommande n'a signalé aucun module de journalisation.",
    it: "Il telecomando non ha segnalato alcun modulo di log.",
    es: "El mando no ha informado de ningún módulo de registro.",
  },
  debug_logging_version: {
    en: "Schema version {version}", de: "Schemaversion {version}",
    fr: "Version du schéma {version}", it: "Versione dello schema {version}",
    es: "Versión del esquema {version}",
  },

  debug_report: {
    en: "Device report", de: "Gerätebericht", fr: "Rapport de l'appareil",
    it: "Rapporto del dispositivo", es: "Informe del dispositivo",
  },
  debug_report_hint: {
    en: "Reads the remote's status, metrics and stored logs. Each section is read from the remote when you expand it. Useful to attach to a bug report.",
    de: "Liest Status, Messwerte und gespeicherte Protokolle der Fernbedienung. Jeder Abschnitt wird beim Aufklappen von der Fernbedienung gelesen. Nützlich als Anhang zu einer Fehlermeldung.",
    fr: "Lit l'état, les mesures et les journaux enregistrés de la télécommande. Chaque section est lue sur la télécommande au moment où vous la dépliez. Utile à joindre à un rapport de bogue.",
    it: "Legge stato, metriche e log memorizzati del telecomando. Ogni sezione viene letta dal telecomando quando la espandi. Utile da allegare a una segnalazione di bug.",
    es: "Lee el estado, las métricas y los registros almacenados del mando. Cada sección se lee del mando al desplegarla. Útil para adjuntar a un informe de error.",
  },
  // Shown while the list of readable endpoints is being fetched. The card is
  // empty until it arrives, and an empty card says nothing about whether
  // anything is happening. ("Ping" stays hard-coded in the view: the word is
  // identical in all five languages.)
  debug_report_fetching: {
    en: "Collecting report…", de: "Bericht wird abgerufen…",
    fr: "Collecte du rapport…", it: "Raccolta del rapporto…",
    es: "Recopilando informe…",
  },
  // Shown on a row that is on the list but has not been fetched yet. The rows
  // appear before any of them is collected, so each needs to say which it is.
  debug_section_pending: {
    en: "collecting…", de: "wird abgerufen…", fr: "collecte…",
    it: "raccolta…", es: "recopilando…",
  },
  debug_section_truncated: {
    en: "Cut off — the device sent {length} characters.",
    de: "Abgeschnitten — das Gerät sendete {length} Zeichen.",
    fr: "Tronqué — l'appareil a envoyé {length} caractères.",
    it: "Troncato — il dispositivo ha inviato {length} caratteri.",
    es: "Truncado — el dispositivo envió {length} caracteres.",
  },
  debug_report_copy: {
    en: "Copy", de: "Kopieren", fr: "Copier", it: "Copia", es: "Copiar",
  },
  debug_traffic: {
    en: "Traffic", de: "Datenverkehr", fr: "Trafic", it: "Traffico", es: "Tráfico",
  },
  debug_traffic_hint: {
    en: "Every message between Home Assistant and the remote since {since}. The round trip runs from sending a request to its answer; a late answer arrived after Home Assistant had given up; a lost request never got one.",
    de: "Alle Nachrichten zwischen Home Assistant und der Fernbedienung seit {since}. Die Antwortzeit läuft vom Senden einer Anfrage bis zu ihrer Antwort; eine verspätete Antwort kam, nachdem Home Assistant aufgegeben hatte; eine verlorene Anfrage bekam nie eine.",
    fr: "Tous les messages entre Home Assistant et la télécommande depuis {since}. L'aller-retour va de l'envoi d'une requête à sa réponse ; une réponse tardive est arrivée après l'abandon de Home Assistant ; une requête perdue n'en a jamais reçu.",
    it: "Tutti i messaggi tra Home Assistant e il telecomando da {since}. Il tempo di andata e ritorno va dall'invio di una richiesta alla sua risposta; una risposta tardiva è arrivata dopo che Home Assistant aveva rinunciato; una richiesta persa non ne ha mai ricevuta una.",
    es: "Todos los mensajes entre Home Assistant y el mando desde {since}. El tiempo de ida y vuelta va del envío de una solicitud a su respuesta; una respuesta tardía llegó después de que Home Assistant se rindiera; una solicitud perdida nunca la recibió.",
  },
  debug_traffic_requests: {
    en: "Requests", de: "Anfragen", fr: "Requêtes", it: "Richieste", es: "Solicitudes",
  },
  debug_traffic_answered: {
    en: "Answered", de: "Beantwortet", fr: "Répondues", it: "Con risposta", es: "Respondidas",
  },
  debug_traffic_timeouts: {
    en: "Timed out", de: "Zeitüberschreitung", fr: "Expirées", it: "Scadute", es: "Agotadas",
  },
  debug_traffic_late: {
    en: "Answered late", de: "Verspätet beantwortet", fr: "Réponse tardive",
    it: "Risposta tardiva", es: "Respuesta tardía",
  },
  debug_traffic_lost: {
    en: "Lost", de: "Verloren", fr: "Perdues", it: "Perse", es: "Perdidas",
  },
  debug_traffic_errors: {
    en: "Error answers", de: "Fehlerantworten", fr: "Réponses d'erreur",
    it: "Risposte di errore", es: "Respuestas de error",
  },
  debug_traffic_unmatched: {
    en: "Unmatched answers", de: "Nicht zuordenbare Antworten", fr: "Réponses sans requête",
    it: "Risposte senza richiesta", es: "Respuestas sin solicitud",
  },
  debug_traffic_rtt: {
    en: "Round trip", de: "Antwortzeit", fr: "Aller-retour", it: "Andata e ritorno", es: "Ida y vuelta",
  },
  debug_traffic_gap: {
    en: "Longest silence", de: "Längste Funkstille", fr: "Plus long silence",
    it: "Silenzio più lungo", es: "Silencio más largo",
  },
  debug_traffic_gaps: {
    en: "Silences of 15 s or more", de: "Funkstillen ab 15 s", fr: "Silences de 15 s ou plus",
    it: "Silenzi di 15 s o più", es: "Silencios de 15 s o más",
  },
  debug_traffic_connections: {
    en: "Connects / disconnects", de: "Verbindungen / Abbrüche", fr: "Connexions / déconnexions",
    it: "Connessioni / disconnessioni", es: "Conexiones / desconexiones",
  },
  debug_traffic_volume: {
    en: "Sent / received", de: "Gesendet / empfangen", fr: "Envoyé / reçu",
    it: "Inviato / ricevuto", es: "Enviado / recibido",
  },
  debug_traffic_frames: {
    en: "Recent messages, newest first", de: "Letzte Nachrichten, neueste zuerst",
    fr: "Derniers messages, les plus récents d'abord", it: "Ultimi messaggi, i più recenti prima",
    es: "Últimos mensajes, los más recientes primero",
  },
  debug_traffic_empty: {
    en: "No messages recorded yet.", de: "Noch keine Nachrichten aufgezeichnet.",
    fr: "Aucun message enregistré pour l'instant.", it: "Nessun messaggio registrato finora.",
    es: "Aún no se ha registrado ningún mensaje.",
  },
  debug_traffic_refresh: {
    en: "Refresh", de: "Aktualisieren", fr: "Actualiser", it: "Aggiorna", es: "Actualizar",
  },
  debug_traffic_reset: {
    en: "Reset", de: "Zurücksetzen", fr: "Réinitialiser", it: "Azzera", es: "Restablecer",
  },
  debug_traffic_log: {
    en: "Write to the log", de: "Ins Protokoll schreiben", fr: "Écrire dans le journal",
    it: "Scrivi nel registro", es: "Escribir en el registro",
  },
  debug_traffic_log_live: {
    en: "Each message is written to {link}.", de: "Jede Nachricht wird nach {link} geschrieben.",
    fr: "Chaque message est écrit dans {link}.", it: "Ogni messaggio viene scritto in {link}.",
    es: "Cada mensaje se escribe en {link}.",
  },
  debug_traffic_copied: {
    en: "Traffic copied to the clipboard ✓", de: "Datenverkehr in die Zwischenablage kopiert ✓",
    fr: "Trafic copié dans le presse-papiers ✓", it: "Traffico copiato negli appunti ✓",
    es: "Tráfico copiado al portapapeles ✓",
  },
  debug_report_copied: {
    en: "Report copied to the clipboard ✓",
    de: "Bericht in die Zwischenablage kopiert ✓",
    fr: "Rapport copié dans le presse-papiers ✓",
    it: "Rapporto copiato negli appunti ✓",
    es: "Informe copiado al portapapeles ✓",
  },
  debug_report_copy_failed: {
    en: "Could not copy: {error}",
    de: "Kopieren fehlgeschlagen: {error}",
    fr: "Copie impossible : {error}",
    it: "Copia non riuscita: {error}",
    es: "No se pudo copiar: {error}",
  },
  action_library: {
    en: "Action Library", de: "Aktionsbibliothek", fr: "Bibliothèque d'actions",
    it: "Libreria azioni", es: "Biblioteca de acciones",
  },
  appearance: {
    en: "Appearance", de: "Darstellung", fr: "Apparence",
    it: "Aspetto", es: "Apariencia",
  },
  button_icons: {
    en: "Button icons", de: "Tastensymbole", fr: "Icônes des touches",
    it: "Icone dei tasti", es: "Iconos de los botones",
  },

  // ── virtual toggle button ──────────────────────────────────────────
  // What the list means, at any length. It used to open with "Add a second
  // action", which is advice rather than a description -- and the line shows
  // for every button that has an action at all, so a button already cycling
  // through three presses was being told to add a second one.
  toggle_click_hint: {
    en: "This button cycles: each press runs the next action, then starts over.",
    de: "Diese Taste schaltet durch: Jeder Druck führt die nächste Aktion aus, dann beginnt es von vorn.",
    fr: "Cette touche défile : chaque pression exécute l'action suivante, puis recommence.",
    it: "Questo tasto scorre: ogni pressione esegue l'azione successiva, poi ricomincia.",
    es: "Este botón alterna: cada pulsación ejecuta la siguiente acción y luego vuelve a empezar.",
  },
  // The advice half, kept separate because it only applies while there is
  // nothing to cycle through yet.
  toggle_click_hint_add: {
    en: "Add another action to build the cycle.",
    de: "Füge eine weitere Aktion hinzu, um den Durchlauf aufzubauen.",
    fr: "Ajoutez une autre action pour construire le cycle.",
    it: "Aggiungi un'altra azione per costruire il ciclo.",
    es: "Añade otra acción para construir el ciclo.",
  },
  // Names what the section edits, not what the user does to the remote. It was
  // "Presses", which named the input while every field under it sets an output,
  // and as a heading read as a count rather than as something configurable.
  // The per-press framing is not lost by dropping it from the title: the
  // numbered rail shows it, and the hint below says it in words.
  toggle_press_appearance: {
    en: "Appearance", de: "Darstellung", fr: "Apparence",
    it: "Aspetto", es: "Apariencia",
  },
  // Carries the one fact the numbered list cannot show. The rail stops after
  // the last press on purpose -- nothing follows the final number -- so the
  // sequence does not appear to run off the end; that the cycle wraps is said
  // here in words instead, which is where the chip strip's loop glyph went
  // when that strip was removed as a duplicate of the list.
  toggle_press_appearance_hint: {
    en: "How the button looks at each step. Each press moves on to the next, and the last starts over.",
    de: "Wie die Taste bei jedem Schritt aussieht. Jeder Druck geht zum nächsten, und nach dem letzten beginnt es von vorn.",
    fr: "L'apparence de la touche à chaque étape. Chaque pression passe à la suivante, et la dernière recommence.",
    it: "L'aspetto del tasto a ogni passo. Ogni pressione passa al successivo e dopo l'ultimo si ricomincia.",
    es: "El aspecto del botón en cada paso. Cada pulsación pasa al siguiente y la última vuelve a empezar.",
  },
  toggle_add_press: {
    en: "Add next press", de: "Nächsten Druck hinzufügen",
    fr: "Ajouter la pression suivante", it: "Aggiungi pressione successiva",
    es: "Añadir siguiente pulsación",
  },
  toggle_pick_action: {
    en: "Pick an action", de: "Aktion wählen", fr: "Choisir une action",
    it: "Scegli un'azione", es: "Elegir una acción",
  },
  template: {
    en: "Template", de: "Vorlage", fr: "Modèle",
    it: "Modello", es: "Plantilla",
  },

  // ── pages ──────────────────────────────────────────────────────────
  add_page: {
    en: "Add page", de: "Seite hinzufügen", fr: "Ajouter une page",
    it: "Aggiungi pagina", es: "Añadir página",
  },
  add_new_page: {
    en: "Add new page", de: "Neue Seite hinzufügen", fr: "Ajouter une nouvelle page",
    it: "Aggiungi nuova pagina", es: "Añadir nueva página",
  },
  adding: {
    en: "Adding…", de: "Wird hinzugefügt…", fr: "Ajout en cours…",
    it: "Aggiunta in corso…", es: "Añadiendo…",
  },
  blank_page: {
    en: "Blank page", de: "Leere Seite", fr: "Page vierge",
    it: "Pagina vuota", es: "Página en blanco",
  },
  delete_page: {
    en: "Delete page", de: "Seite löschen", fr: "Supprimer la page",
    it: "Elimina pagina", es: "Eliminar página",
  },
  // A subpage keeps everything a page has; it is only taken out of the list
  // the remote itself pages through. The wording says what the page becomes,
  // not what is done to it, because the same menu item reads as the opposite
  // instruction on a page that is already a subpage.
  make_subpage: {
    en: "Make subpage", de: "Zu Unterseite machen", fr: "Convertir en sous-page",
    it: "Rendi sottopagina", es: "Convertir en subpágina",
  },
  make_mainpage: {
    en: "Make main page", de: "Zu Hauptseite machen", fr: "Convertir en page principale",
    it: "Rendi pagina principale", es: "Convertir en página principal",
  },
  // The page menu's item: the menu is already about the page, so the noun
  // is left out, as in Home Assistant's own menus.
  duplicate_page: {
    en: "Duplicate", de: "Duplizieren", fr: "Dupliquer",
    it: "Duplica", es: "Duplicar",
  },
  change_device: {
    en: "Change device…", de: "Gerät ändern…", fr: "Changer d'appareil…",
    it: "Cambia dispositivo…", es: "Cambiar dispositivo…",
  },
  change_hub: {
    en: "Change hub…", de: "Hub ändern…", fr: "Changer de hub…",
    it: "Cambia hub…", es: "Cambiar hub…",
  },
  template_device: {
    en: "Device", de: "Gerät", fr: "Appareil", it: "Dispositivo", es: "Dispositivo",
  },
  template_hub: {
    en: "Hub", de: "Hub", fr: "Hub", it: "Hub", es: "Hub",
  },
  template_target_missing: {
    en: "Device not found", de: "Gerät nicht gefunden", fr: "Appareil introuvable",
    it: "Dispositivo non trovato", es: "Dispositivo no encontrado",
  },
  change_device_confirm: {
    en: "Change device", de: "Gerät ändern", fr: "Changer d'appareil",
    it: "Cambia dispositivo", es: "Cambiar dispositivo",
  },
  change_hub_confirm: {
    en: "Change hub", de: "Hub ändern", fr: "Changer de hub",
    it: "Cambia hub", es: "Cambiar hub",
  },
  changing: {
    en: "Changing…", de: "Wird geändert…", fr: "Modification…",
    it: "Modifica in corso…", es: "Cambiando…",
  },
  device_changed: {
    en: "{name} now uses the new device: {n} button(s) updated",
    de: "{name} nutzt jetzt das neue Gerät: {n} Taste(n) angepasst",
    fr: "{name} utilise le nouvel appareil : {n} bouton(s) mis à jour",
    it: "{name} usa ora il nuovo dispositivo: {n} pulsante/i aggiornato/i",
    es: "{name} usa ahora el nuevo dispositivo: {n} botón(es) actualizado(s)",
  },
  // A page no template made, given a device: `${_device…}` then reads it and
  // "Change device…" moves it, as on a template page.
  // A button's options: a subpage of its own that its long touch opens.
  add_options: {
    en: "Add options…", de: "Optionen hinzufügen…", fr: "Ajouter des options…",
    it: "Aggiungi opzioni…", es: "Añadir opciones…",
  },
  // The same thing, worded as a place rather than a command: the title and
  // first crumb of the walk the menu item opens.
  add_options_title: {
    en: "Add options", de: "Optionen hinzufügen", fr: "Ajouter des options",
    it: "Aggiungi opzioni", es: "Añadir opciones",
  },
  // Add options… on a button whose device no options template answers.
  no_options: {
    en: "No options available for {name}", de: "Keine Optionen für {name} verfügbar",
    fr: "Aucune option disponible pour {name}", it: "Nessuna opzione disponibile per {name}",
    es: "No hay opciones disponibles para {name}",
  },
  options_page_title: {
    en: "{name} options", de: "{name} Optionen", fr: "Options {name}",
    it: "Opzioni {name}", es: "Opciones de {name}",
  },
  options_added: {
    en: "Options page added for {name}: a long touch opens it",
    de: "Optionsseite für {name} angelegt: ein langer Druck öffnet sie",
    fr: "Page d'options ajoutée pour {name} : un appui long l'ouvre",
    it: "Pagina opzioni aggiunta per {name}: una pressione lunga la apre",
    es: "Página de opciones añadida para {name}: una pulsación larga la abre",
  },
  assign_device: {
    en: "Assign device…", de: "Gerät zuweisen…", fr: "Attribuer un appareil…",
    it: "Assegna dispositivo…", es: "Asignar dispositivo…",
  },
  assign_device_desc: {
    en: "The page's device: ${_device} in its title and buttons reads it, and the page can later be moved to another device.",
    de: "Das Gerät der Seite: ${_device} in Titel und Tasten liest es, und die Seite lässt sich später auf ein anderes Gerät umstellen.",
    fr: "L'appareil de la page : ${_device} dans son titre et ses boutons le lit, et la page peut ensuite passer à un autre appareil.",
    it: "Il dispositivo della pagina: ${_device} nel titolo e nei pulsanti lo legge, e la pagina può poi passare a un altro dispositivo.",
    es: "El dispositivo de la página: ${_device} en su título y botones lo lee, y la página puede pasar después a otro dispositivo.",
  },
  assign_device_confirm: {
    en: "Assign", de: "Zuweisen", fr: "Attribuer", it: "Assegna", es: "Asignar",
  },
  device_assigned: {
    en: "{name} now uses this device", de: "{name} nutzt jetzt dieses Gerät",
    fr: "{name} utilise maintenant cet appareil", it: "{name} usa ora questo dispositivo",
    es: "{name} usa ahora este dispositivo",
  },
  save: {
    en: "Save", de: "Speichern", fr: "Enregistrer", it: "Salva", es: "Guardar",
  },
  // Same shape as device_changed, but a config-entry target is a hub, not a
  // device -- a page retargeted onto one was reporting "new device" in every
  // language regardless of which kind of target it actually got.
  hub_changed: {
    en: "{name} now uses the new hub: {n} button(s) updated",
    de: "{name} nutzt jetzt den neuen Hub: {n} Taste(n) angepasst",
    fr: "{name} utilise le nouveau hub : {n} bouton(s) mis à jour",
    it: "{name} usa ora il nuovo hub: {n} pulsante/i aggiornato/i",
    es: "{name} usa ahora el nuevo hub: {n} botón(es) actualizado(s)",
  },
  template_gone: {
    en: "The template \"{name}\" this page was made from is no longer available",
    de: "Die Vorlage „{name}“, aus der diese Seite erstellt wurde, ist nicht mehr verfügbar",
    fr: "La mise en page « {name} » d'origine de cette page n'est plus disponible",
    it: "Il modello \"{name}\" da cui è stata creata questa pagina non è più disponibile",
    es: "La plantilla \"{name}\" de la que se creó esta página ya no está disponible",
  },
  page_duplicated: {
    en: "{name} duplicated", de: "{name} dupliziert",
    fr: "{name} dupliquée", it: "{name} duplicata",
    es: "{name} duplicada",
  },
  duplicate_page_failed: {
    en: "Could not duplicate the page: {error}",
    de: "Seite konnte nicht dupliziert werden: {error}",
    fr: "Impossible de dupliquer la page : {error}",
    it: "Impossibile duplicare la pagina: {error}",
    es: "No se ha podido duplicar la página: {error}",
  },
  move_left: {
    en: "Move left", de: "Nach links verschieben", fr: "Déplacer vers la gauche",
    it: "Sposta a sinistra", es: "Mover a la izquierda",
  },
  move_right: {
    en: "Move right", de: "Nach rechts verschieben", fr: "Déplacer vers la droite",
    it: "Sposta a destra", es: "Mover a la derecha",
  },
  page_default: {
    en: "Page default", de: "Seitenstandard", fr: "Valeur par défaut de la page",
    it: "Predefinito della pagina", es: "Predeterminado de la página",
  },
  a11y_editing: {
    en: "Editing {name}", de: "{name} wird bearbeitet", fr: "Modification de {name}",
    it: "Modifica di {name}", es: "Editando {name}",
  },
  a11y_editing_generic: {
    en: "Editing button", de: "Taste wird bearbeitet", fr: "Modification du bouton",
    it: "Modifica del pulsante", es: "Editando el botón",
  },
  a11y_editor_closed: {
    en: "Closed editor for {name}", de: "Editor für {name} geschlossen",
    fr: "Éditeur de {name} fermé", it: "Editor di {name} chiuso",
    es: "Editor de {name} cerrado",
  },
  a11y_editor_closed_generic: {
    en: "Closed button editor", de: "Tasteneditor geschlossen",
    fr: "Éditeur de bouton fermé", it: "Editor del pulsante chiuso",
    es: "Editor de botón cerrado",
  },
  a11y_config_region: {
    en: "Settings for {name}", de: "Einstellungen für {name}",
    fr: "Paramètres de {name}", it: "Impostazioni di {name}",
    es: "Ajustes de {name}",
  },
  a11y_config_region_generic: {
    en: "Button settings", de: "Tasteneinstellungen", fr: "Paramètres du bouton",
    it: "Impostazioni del pulsante", es: "Ajustes del botón",
  },
  a11y_page_region: {
    en: "Page settings", de: "Seiteneinstellungen", fr: "Paramètres de la page",
    it: "Impostazioni della pagina", es: "Ajustes de la página",
  },
  a11y_editing_title: {
    en: "Editing page title", de: "Seitentitel wird bearbeitet",
    fr: "Modification du titre de la page", it: "Modifica del titolo della pagina",
    es: "Editando el título de la página",
  },
  a11y_title_closed: {
    en: "Closed page title editor", de: "Seitentitel-Editor geschlossen",
    fr: "Éditeur du titre de la page fermé", it: "Editor del titolo della pagina chiuso",
    es: "Editor del título de la página cerrado",
  },

  // ── templates ────────────────────────────────────────────────────────
  // The add-page list labels its two groups the way Home Assistant's own
  // pickers do, rather than leaving an unexplained rule between them.
  // "Suggestions" and "Other" are both verbatim HA wording.
  suggested_options: {
    en: "Suggestions", de: "Vorschläge", fr: "Suggestions",
    it: "Suggerimenti", es: "Sugerencias",
  },
  other_options: {
    en: "Other", de: "Sonstige", fr: "Autres",
    it: "Altri", es: "Otros",
  },
  choose_template: {
    en: "Choose template", de: "Vorlage wählen", fr: "Choisir un modèle",
    it: "Scegli un modello", es: "Elegir plantilla",
  },
  // What a folder holds, counted the way Home Assistant counts an
  // integration's devices or entities: a measure of what is inside, not of
  // the rows the next step happens to draw.
  template_count: {
    en: "{count} templates", de: "{count} Vorlagen", fr: "{count} modèles",
    it: "{count} modelli", es: "{count} plantillas",
  },
  template_count_one: {
    en: "1 template", de: "1 Vorlage", fr: "1 modèle",
    it: "1 modello", es: "1 plantilla",
  },
  // After the name of a template that brings subpages, on its row and in its
  // dialog: adding it makes more than the one page the user is looking at.
  template_page_count: {
    en: "({count} pages)", de: "({count} Seiten)", fr: "({count} pages)",
    it: "({count} pagine)", es: "({count} páginas)",
  },
  search_templates: {
    en: "Search templates…", de: "Vorlagen suchen…", fr: "Rechercher un modèle…",
    it: "Cerca modelli…", es: "Buscar plantillas…",
  },
  search_result_count: {
    en: "{count} results", de: "{count} Treffer", fr: "{count} résultats",
    it: "{count} risultati", es: "{count} resultados",
  },
  search_no_matches: {
    en: "Nothing matches “{query}”.", de: "Nichts passt zu „{query}“.",
    fr: "Rien ne correspond à « {query} ».", it: "Nessun risultato per “{query}”.",
    es: "Nada coincide con «{query}».",
  },
  search_no_matches_hint: {
    en: "Try a device name, or clear the search to browse.",
    de: "Versuch einen Gerätenamen, oder leere die Suche zum Blättern.",
    fr: "Essayez un nom d'appareil, ou effacez la recherche pour parcourir.",
    it: "Prova il nome di un dispositivo, o cancella la ricerca per sfogliare.",
    es: "Prueba con el nombre de un dispositivo, o borra la búsqueda para explorar.",
  },
  add_page_root: {
    en: "Add page", de: "Seite hinzufügen", fr: "Ajouter une page",
    it: "Aggiungi pagina", es: "Añadir página",
  },
  configure_manually: {
    en: "Configure buttons manually", de: "Tasten manuell einrichten",
    fr: "Configurer les touches manuellement",
    it: "Configura i tasti manualmente",
    es: "Configurar los botones manualmente",
  },
  preconfigured_remote: {
    en: "Pre-configured device remote", de: "Vorkonfigurierte Gerätefernbedienung",
    fr: "Télécommande d'appareil préconfigurée",
    it: "Telecomando dispositivo preconfigurato",
    es: "Mando de dispositivo preconfigurado",
  },
  no_templates: {
    en: "No templates available", de: "Keine Vorlagen verfügbar",
    fr: "Aucun modèle disponible", it: "Nessun modello disponibile",
    es: "No hay plantillas disponibles",
  },
  template_added: {
    en: 'Template "{name}" added ✓',
    de: "Vorlage „{name}“ hinzugefügt ✓",
    fr: "Modèle « {name} » ajouté ✓",
    it: 'Modello "{name}" aggiunto ✓',
    es: "Plantilla «{name}» añadida ✓",
  },
  template_no_target: {
    en: "This template declares no target selector and cannot be added.",
    de: "Diese Vorlage deklariert keinen Zielselektor und kann nicht hinzugefügt werden.",
    fr: "Ce modèle ne déclare aucun sélecteur de cible et ne peut pas être ajouté.",
    it: "Questo modello non dichiara alcun selettore di destinazione e non può essere aggiunto.",
    es: "Esta plantilla no declara ningún selector de destino y no se puede añadir.",
  },
  range_min: {
    en: "Min", de: "Min", fr: "Min", it: "Min", es: "Mín",
  },
  range_max: {
    en: "Max", de: "Max", fr: "Max", it: "Max", es: "Máx",
  },
  device_online: {
    en: "Online", de: "Online", fr: "En ligne", it: "Online", es: "En línea",
  },
  device_offline: {
    en: "Offline", de: "Offline", fr: "Hors ligne", it: "Offline", es: "Sin conexión",
  },
  // A third state: two could not tell "the device says it is down" apart from
  // "we never managed to ask", and announced aloud (4.1.3) that guess becomes
  // a spoken falsehood. One word, and no longer than es "Sin conexión" (12),
  // which is what the toolbar's reflow breakpoint was measured against.
  device_unknown: {
    en: "Unknown", de: "Unbekannt", fr: "Inconnu", it: "Sconosciuto", es: "Desconocido",
  },
  // What the live region says when the state changes. The bare word is what
  // the pill shows, but out of context "Offline" alone does not say offline
  // *what* -- and a status message arrives with no surrounding screen to read
  // it against, so it names the device it is about.
  device_status_announced: {
    en: "{name}: {state}", de: "{name}: {state}", fr: "{name} : {state}",
    it: "{name}: {state}", es: "{name}: {state}",
  },
  back: {
    en: "Back", de: "Zurück", fr: "Retour", it: "Indietro", es: "Atrás",
  },
  badge_unused: {
    en: "unused", de: "nicht verwendet", fr: "non utilisé",
    it: "non utilizzato", es: "sin usar",
  },
  badge_duplicate: {
    en: "duplicate", de: "Duplikat", fr: "doublon",
    it: "duplicato", es: "duplicado",
  },
  badge_duplicate_hint: {
    en: "Another entry does exactly the same thing and looks the same.",
    de: "Ein anderer Eintrag tut genau dasselbe und sieht gleich aus.",
    fr: "Une autre entrée fait exactement la même chose et a la même apparence.",
    it: "Un'altra voce fa esattamente la stessa cosa e ha lo stesso aspetto.",
    es: "Otra entrada hace exactamente lo mismo y tiene el mismo aspecto.",
  },

  // ── action library: scope, sort and cleanup ────────────────────────
  scope_all: {
    en: "All", de: "Alle", fr: "Toutes", it: "Tutte", es: "Todas",
  },
  scope_in_use: {
    en: "In use", de: "Verwendet", fr: "Utilisées",
    it: "In uso", es: "En uso",
  },
  scope_unused: {
    en: "Unused", de: "Unbenutzt", fr: "Inutilisées",
    it: "Non usate", es: "Sin usar",
  },
  scope_duplicates: {
    en: "Duplicates", de: "Duplikate", fr: "Doublons",
    it: "Duplicati", es: "Duplicados",
  },
  filter_by_usage: {
    en: "Filter by usage", de: "Nach Verwendung filtern",
    fr: "Filtrer par utilisation", it: "Filtra per utilizzo",
    es: "Filtrar por uso",
  },
  sort_label: {
    en: "Sort", de: "Sortieren", fr: "Trier", it: "Ordina", es: "Ordenar",
  },
  sort_by_domain: {
    en: "By type", de: "Nach Typ", fr: "Par type",
    it: "Per tipo", es: "Por tipo",
  },
  sort_by_name: {
    en: "By name", de: "Nach Name", fr: "Par nom",
    it: "Per nome", es: "Por nombre",
  },
  sort_by_usage: {
    en: "Most used", de: "Meistverwendet", fr: "Les plus utilisées",
    it: "Più usate", es: "Más usadas",
  },
  group_no_service: {
    en: "No service", de: "Kein Dienst", fr: "Aucun service",
    it: "Nessun servizio", es: "Sin servicio",
  },
  unused_explainer: {
    en: "{n} actions are on no button.",
    de: "{n} Aktionen liegen auf keiner Taste.",
    fr: "{n} actions ne sont sur aucune touche.",
    it: "{n} azioni non sono su alcun tasto.",
    es: "{n} acciones no están en ningún botón.",
  },
  remove_unused_action: {
    en: "Remove {n}", de: "{n} entfernen", fr: "Supprimer {n}",
    it: "Rimuovi {n}", es: "Eliminar {n}",
  },
  remove_unused_confirm: {
    en: "Remove {n} unused actions?",
    de: "{n} unbenutzte Aktionen entfernen?",
    fr: "Supprimer {n} actions inutilisées ?",
    it: "Rimuovere {n} azioni non usate?",
    es: "¿Eliminar {n} acciones sin usar?",
  },
  remove_unused_hint: {
    en: "They are on no button on any page. This cannot be undone.",
    de: "Sie liegen auf keiner Taste einer Seite. Dies kann nicht rückgängig gemacht werden.",
    fr: "Elles ne sont sur aucune touche d'aucune page. Cette opération est irréversible.",
    it: "Non sono su alcun tasto di alcuna pagina. L'operazione non può essere annullata.",
    es: "No están en ningún botón de ninguna página. Esto no se puede deshacer.",
  },
  removed_unused_toast: {
    en: "Removed {n} unused actions",
    de: "{n} unbenutzte Aktionen entfernt",
    fr: "{n} actions inutilisées supprimées",
    it: "Rimosse {n} azioni non usate",
    es: "{n} acciones sin usar eliminadas",
  },
  duplicates_explainer: {
    en: "{n} actions are exact copies of another one.",
    de: "{n} Aktionen sind exakte Kopien einer anderen.",
    fr: "{n} actions sont des copies exactes d'une autre.",
    it: "{n} azioni sono copie esatte di un'altra.",
    es: "{n} acciones son copias exactas de otra.",
  },
  merge_duplicates_action: {
    en: "Merge {n}", de: "{n} zusammenführen", fr: "Fusionner {n}",
    it: "Unisci {n}", es: "Combinar {n}",
  },
  merge_duplicates_confirm: {
    en: "Merge {n} duplicate actions?",
    de: "{n} doppelte Aktionen zusammenführen?",
    fr: "Fusionner {n} actions en double ?",
    it: "Unire {n} azioni duplicate?",
    es: "¿Combinar {n} acciones duplicadas?",
  },
  merge_duplicates_hint: {
    en: "Every button keeps working: it is pointed at the copy that stays. Nothing about how they look or behave changes.",
    de: "Jede Taste funktioniert weiter: Sie wird auf die verbleibende Kopie umgestellt. An Aussehen und Verhalten ändert sich nichts.",
    fr: "Chaque touche continue de fonctionner : elle est dirigée vers la copie conservée. Ni l'apparence ni le comportement ne changent.",
    it: "Ogni tasto continua a funzionare: viene puntato sulla copia che resta. Aspetto e comportamento non cambiano.",
    es: "Cada botón sigue funcionando: se apunta a la copia que permanece. No cambia ni su aspecto ni su comportamiento.",
  },
  merged_duplicates_toast: {
    en: "Merged {n} duplicate actions",
    de: "{n} doppelte Aktionen zusammengeführt",
    fr: "{n} actions en double fusionnées",
    it: "Unite {n} azioni duplicate",
    es: "{n} acciones duplicadas combinadas",
  },
  merge_failed: {
    en: "Merge failed", de: "Zusammenführen fehlgeschlagen",
    fr: "Échec de la fusion", it: "Unione non riuscita",
    es: "Error al combinar",
  },
  action_merge_pages_failed: {
    en: "Merged, but these pages could not be updated: {pages}",
    de: "Zusammengeführt, aber diese Seiten konnten nicht aktualisiert werden: {pages}",
    fr: "Fusionnées, mais ces pages n'ont pas pu être mises à jour : {pages}",
    it: "Unite, ma non è stato possibile aggiornare queste pagine: {pages}",
    es: "Combinadas, pero no se han podido actualizar estas páginas: {pages}",
  },
  // Says why the cleanup is unavailable rather than only that it is: the scan
  // decides what counts as unused, so a page it could not read is the whole
  // reason an action here might look safe to delete when it is not.
  usage_scan_incomplete: {
    en: "Some pages could not be read, so unused actions cannot be identified reliably. Reload to try again.",
    de: "Einige Seiten konnten nicht gelesen werden, daher lassen sich unbenutzte Aktionen nicht zuverlässig bestimmen. Zum erneuten Versuch neu laden.",
    fr: "Certaines pages n'ont pas pu être lues ; les actions inutilisées ne peuvent donc pas être identifiées de façon fiable. Rechargez pour réessayer.",
    it: "Non è stato possibile leggere alcune pagine, quindi le azioni non usate non possono essere individuate in modo affidabile. Ricarica per riprovare.",
    es: "No se han podido leer algunas páginas, por lo que no se pueden identificar de forma fiable las acciones sin usar. Vuelve a cargar para reintentarlo.",
  },
  no_unused_actions: {
    en: "Every action is on a button.",
    de: "Jede Aktion liegt auf einer Taste.",
    fr: "Chaque action est sur une touche.",
    it: "Ogni azione è su un tasto.",
    es: "Cada acción está en un botón.",
  },
  no_duplicate_actions: {
    en: "No action is an exact copy of another.",
    de: "Keine Aktion ist eine exakte Kopie einer anderen.",
    fr: "Aucune action n'est la copie exacte d'une autre.",
    it: "Nessuna azione è la copia esatta di un'altra.",
    es: "Ninguna acción es copia exacta de otra.",
  },
  no_used_actions: {
    en: "No action is on a button yet.",
    de: "Noch liegt keine Aktion auf einer Taste.",
    fr: "Aucune action n'est encore sur une touche.",
    it: "Nessuna azione è ancora su un tasto.",
    es: "Todavía no hay ninguna acción en un botón.",
  },
  delete_action_in_use: {
    en: "It is on {n} buttons. They lose it, and this cannot be undone.",
    de: "Sie liegt auf {n} Tasten. Diese verlieren sie, und das kann nicht rückgängig gemacht werden.",
    fr: "Elle est sur {n} touches. Elles la perdent, et cette opération est irréversible.",
    it: "È su {n} tasti. La perderanno, e l'operazione non può essere annullata.",
    es: "Está en {n} botones. La perderán, y esto no se puede deshacer.",
  },
  delete_action_unused_hint: {
    en: "It is on no button. This cannot be undone.",
    de: "Sie liegt auf keiner Taste. Dies kann nicht rückgängig gemacht werden.",
    fr: "Elle n'est sur aucune touche. Cette opération est irréversible.",
    it: "Non è su alcun tasto. L'operazione non può essere annullata.",
    es: "No está en ningún botón. Esto no se puede deshacer.",
  },
  a11y_usage_count: {
    en: "used by {n} buttons", de: "von {n} Tasten verwendet",
    fr: "utilisé par {n} touches", it: "usato da {n} tasti",
    es: "usado por {n} teclas",
  },
  a11y_state_icons: {
    en: "{n} state icons", de: "{n} Status-Symbole",
    fr: "{n} icônes d'état", it: "{n} icone di stato",
    es: "{n} iconos de estado",
  },
  target_hub: {
    en: "Target hub", de: "Ziel-Hub", fr: "Hub cible",
    it: "Hub di destinazione", es: "Hub de destino",
  },
  target_device: {
    en: "Target device", de: "Zielgerät", fr: "Appareil cible",
    it: "Dispositivo di destinazione", es: "Dispositivo de destino",
  },
  loading_hubs: {
    en: "Loading…", de: "Wird geladen…", fr: "Chargement…",
    it: "Caricamento…", es: "Cargando…",
  },
  loading_devices: {
    en: "Loading devices…", de: "Geräte werden geladen…",
    fr: "Chargement des appareils…", it: "Caricamento dispositivi…",
    es: "Cargando dispositivos…",
  },
  // ── a list with no remotes in it yet ───────────────────────────────
  // The first three steps of the setup page, shown where the rows will be.
  // The `_text` values carry <strong> markup and are written by us, never user input.
  // As the heading of the setup page (www/info/index.html) words it.
  setup_steps_heading: {
    en: "Get started with your lizaIP.",
    de: "Los geht's mit deiner lizaIP.",
    fr: "Premiers pas avec votre lizaIP.",
    it: "Inizia con la tua lizaIP.",
    es: "Empieza con tu lizaIP.",
  },
  setup_wake_title: {
    en: "Wake up",
    de: "Aufwecken",
    fr: "Réveiller",
    it: "Accendere",
    es: "Despertar",
  },
  setup_wake_text: {
    en: "Plug lizaIP into any USB power supply or charger.",
    de: "Schließe lizaIP an ein beliebiges USB-Netzteil oder Ladegerät an.",
    fr: "Branchez lizaIP sur n'importe quelle alimentation ou chargeur USB.",
    it: "Collega lizaIP a un qualsiasi alimentatore o caricabatterie USB.",
    es: "Conecta lizaIP a cualquier fuente de alimentación o cargador USB.",
  },
  setup_connect_title: {
    en: "Connect",
    de: "Verbinden",
    fr: "Connecter",
    it: "Collegare",
    es: "Conectar",
  },
  setup_connect_text: {
    en: "Open the Wi-Fi settings and join the network named <strong>lizaIP-xxxxxx</strong>.",
    de: "Öffne die WLAN-Einstellungen und verbinde dich mit dem Netzwerk <strong>lizaIP-xxxxxx</strong>.",
    fr: "Ouvrez les réglages Wi-Fi et rejoignez le réseau <strong>lizaIP-xxxxxx</strong>.",
    it: "Apri le impostazioni Wi-Fi e connettiti alla rete <strong>lizaIP-xxxxxx</strong>.",
    es: "Abre los ajustes de Wi-Fi y únete a la red <strong>lizaIP-xxxxxx</strong>.",
  },
  setup_provision_title: {
    en: "Provision",
    de: "Einrichten",
    fr: "Configurer",
    it: "Configurare",
    es: "Configurar",
  },
  setup_provision_text: {
    en: "Scan the QR code, or open <strong>172.16.10.1</strong> in a web browser. Pick your home Wi-Fi network.",
    de: "Scanne den QR-Code oder öffne <strong>172.16.10.1</strong> in einem Webbrowser. Wähle dein Heim-WLAN aus.",
    fr: "Scannez le code QR ou ouvrez <strong>172.16.10.1</strong> dans un navigateur web. Choisissez votre réseau Wi-Fi domestique.",
    it: "Scansiona il codice QR oppure apri <strong>172.16.10.1</strong> in un browser web. Scegli la tua rete Wi-Fi di casa.",
    es: "Escanea el código QR o abre <strong>172.16.10.1</strong> en un navegador web. Elige tu red Wi-Fi doméstica.",
  },

  // ── a list with none of them assigned to you ───────────────────────
  // Somebody who is not an administrator and holds no remote. Not a call to
  // action either: there is nobody here to ask but the administrator.
  no_assigned_remotes: {
    en: "No remote has been assigned to you yet. Ask an administrator to assign you one.",
    de: "Dir wurde noch keine Fernbedienung zugewiesen. Bitte eine Administratorin oder einen Administrator darum.",
    fr: "Aucune télécommande ne vous a encore été attribuée. Demandez à un administrateur de vous en attribuer une.",
    it: "Non ti è ancora stato assegnato alcun telecomando. Chiedi a un amministratore di assegnartene uno.",
    es: "Todavía no se te ha asignado ningún mando. Pide a un administrador que te asigne uno.",
  },

  // ── who a remote is assigned to ────────────────────────────────────
  // Administrators only. "People" rather than "users": the dialog lists the
  // persons Home Assistant knows, which is what a household recognises.
  assigned_people: {
    en: "Assign user",
    de: "Benutzer zuweisen",
    fr: "Attribuer un utilisateur",
    it: "Assegna utente",
    es: "Asignar usuario",
  },
  assign_user_menu: {
    en: "Assign user…",
    de: "Benutzer zuweisen…",
    fr: "Attribuer un utilisateur…",
    it: "Assegna utente…",
    es: "Asignar usuario…",
  },
  assigned_people_hint: {
    en: "Only these users will see the remote.",
    de: "Nur diese Benutzer sehen die Fernbedienung.",
    fr: "Seuls ces utilisateurs verront la télécommande.",
    it: "Solo questi utenti vedranno il telecomando.",
    es: "Solo estos usuarios verán el mando.",
  },
  assigned_people_section: {
    en: "Users",
    de: "Benutzer",
    fr: "Utilisateurs",
    it: "Utenti",
    es: "Usuarios",
  },
  assigned_people_count: {
    en: "{count} of {total} selected",
    de: "{count} von {total} ausgewählt",
    fr: "{count} sur {total} sélectionnés",
    it: "{count} di {total} selezionati",
    es: "{count} de {total} seleccionados",
  },
  assigned_people_search: {
    en: "Search users",
    de: "Benutzer suchen",
    fr: "Rechercher des utilisateurs",
    it: "Cerca utenti",
    es: "Buscar usuarios",
  },
  assigned_people_no_match: {
    en: "No users match your search.",
    de: "Keine Benutzer passen zur Suche.",
    fr: "Aucun utilisateur ne correspond à la recherche.",
    it: "Nessun utente corrisponde alla ricerca.",
    es: "Ningún usuario coincide con la búsqueda.",
  },
  assigned_people_saved: {
    en: "Assigned users saved",
    de: "Zugewiesene Benutzer gespeichert",
    fr: "Utilisateurs attribués enregistrés",
    it: "Utenti assegnati salvati",
    es: "Usuarios asignados guardados",
  },
  assigned_people_none: {
    en: "Home Assistant has no users set up yet.",
    de: "In Home Assistant sind noch keine Benutzer angelegt.",
    fr: "Aucun utilisateur n'est encore configuré dans Home Assistant.",
    it: "In Home Assistant non è ancora configurato alcun utente.",
    es: "Todavía no hay usuarios configurados en Home Assistant.",
  },
  assigned_people_summary: {
    en: "Assigned to {names}",
    de: "Zugewiesen an {names}",
    fr: "Attribuée à {names}",
    it: "Assegnato a {names}",
    es: "Asignado a {names}",
  },
  assigned_people_pair: {
    en: "{first} and {second}",
    de: "{first} und {second}",
    fr: "{first} et {second}",
    it: "{first} e {second}",
    es: "{first} y {second}",
  },
  assigned_people_more: {
    en: "{names} +{count}",
    de: "{names} +{count}",
    fr: "{names} +{count}",
    it: "{names} +{count}",
    es: "{names} +{count}",
  },
  assigned_people_unnamed: {
    en: "{count} without a name",
    de: "{count} ohne Namen",
    fr: "{count} sans nom",
    it: "{count} senza nome",
    es: "{count} sin nombre",
  },
  assigned_people_saving: {
    en: "Saving…", de: "Wird gespeichert…", fr: "Enregistrement…",
    it: "Salvataggio…", es: "Guardando…",
  },
  assigned_people_failed: {
    en: "Could not change who this remote is assigned to",
    de: "Die Zuweisung dieser Fernbedienung konnte nicht geändert werden",
    fr: "Impossible de modifier l'attribution de cette télécommande",
    it: "Non è stato possibile modificare l'assegnazione di questo telecomando",
    es: "No se pudo cambiar la asignación de este mando",
  },

  // ── remotes waiting to be added ────────────────────────────────────
  discovered_heading: {
    en: "Discovered",
    de: "Entdeckt",
    fr: "Détectés",
    it: "Rilevati",
    es: "Detectados",
  },
  devices_heading: {
    en: "Devices",
    de: "Geräte",
    fr: "Appareils",
    it: "Dispositivi",
    es: "Dispositivos",
  },
  discovery_fallback_name: {
    en: "lizaIP remote", de: "lizaIP-Fernbedienung",
    fr: "Télécommande lizaIP", it: "Telecomando lizaIP",
    es: "Mando lizaIP",
  },
  discovery_add: {
    en: "Add", de: "Hinzufügen", fr: "Ajouter", it: "Aggiungi", es: "Añadir",
  },
  discovery_adding: {
    en: "Adding…", de: "Wird hinzugefügt…", fr: "Ajout…",
    it: "Aggiunta…", es: "Añadiendo…",
  },
  discovery_added: {
    en: "{name} added", de: "{name} hinzugefügt", fr: "{name} ajoutée",
    it: "{name} aggiunto", es: "{name} añadido",
  },
  discovery_gone: {
    en: "That remote is no longer available",
    de: "Diese Fernbedienung ist nicht mehr verfügbar",
    fr: "Cette télécommande n'est plus disponible",
    it: "Quel telecomando non è più disponibile",
    es: "Ese mando ya no está disponible",
  },
  discovery_add_failed: {
    en: "Could not add the remote: {error}",
    de: "Fernbedienung konnte nicht hinzugefügt werden: {error}",
    fr: "Impossible d'ajouter la télécommande : {error}",
    it: "Impossibile aggiungere il telecomando: {error}",
    es: "No se pudo añadir el mando: {error}",
  },

  // ── buttons ────────────────────────────────────────────────────────
  not_assigned_to_button: {
    en: "Not assigned to any button", de: "Keiner Taste zugewiesen",
    fr: "Attribuée à aucune touche", it: "Non assegnata ad alcun tasto",
    es: "No asignada a ningún botón",
  },
  assigned_to: {
    en: "Assigned to", de: "Zugewiesen an", fr: "Attribuée à",
    it: "Assegnata a", es: "Asignada a",
  },
  unassign_all_confirm: {
    en: "Unassign all buttons on this page?",
    de: "Alle Tasten dieser Seite freigeben?",
    fr: "Libérer toutes les touches de cette page ?",
    it: "Rimuovere l'assegnazione di tutti i tasti di questa pagina?",
    es: "¿Desasignar todos los botones de esta página?",
  },
  different_scope: {
    en: "That button is configured in a different scope",
    de: "Diese Taste ist in einem anderen Gültigkeitsbereich konfiguriert",
    fr: "Cette touche est configurée dans une autre portée",
    it: "Quel tasto è configurato in un ambito diverso",
    es: "Ese botón está configurado en otro ámbito",
  },
  not_a_button_slot: {
    en: "Only buttons can exchange configurations",
    de: "Nur Tasten können Konfigurationen austauschen",
    fr: "Seules les touches peuvent échanger leurs configurations",
    it: "Solo i tasti possono scambiarsi le configurazioni",
    es: "Solo los botones pueden intercambiar configuraciones",
  },
  no_actions_yet: {
    en: "No actions yet. Assign actions to buttons in the {tab} tab.",
    de: "Noch keine Aktionen. Weise Tasten im Reiter {tab} Aktionen zu.",
    fr: "Aucune action pour l'instant. Attribuez des actions aux touches dans l'onglet {tab}.",
    it: "Ancora nessuna azione. Assegna azioni ai tasti nella scheda {tab}.",
    es: "Aún no hay acciones. Asigna acciones a los botones en la pestaña {tab}.",
  },

  // ── validation messages ────────────────────────────────────────────
  // Each says what a correct answer looks like, not just that it was wrong:
  // WCAG 3.3.3 asks for a suggestion where one is known.
  invalid_number: {
    en: "Enter a number.", de: "Zahl eingeben.",
    fr: "Saisissez un nombre.", it: "Inserisci un numero.",
    es: "Introduce un número.",
  },
  invalid_range: {
    en: "Enter a number between {min} and {max}.",
    de: "Zahl zwischen {min} und {max} eingeben.",
    fr: "Saisissez un nombre entre {min} et {max}.",
    it: "Inserisci un numero compreso tra {min} e {max}.",
    es: "Introduce un número entre {min} y {max}.",
  },
  invalid_min_max: {
    en: "Maximum must be greater than minimum.",
    de: "Maximum muss größer als Minimum sein.",
    fr: "Le maximum doit être supérieur au minimum.",
    it: "Il massimo deve essere maggiore del minimo.",
    es: "El máximo debe ser mayor que el mínimo.",
  },

  // ── tooltips and sliders ───────────────────────────────────────────
  reset_tooltip: {
    en: "Reset to auto-generated tooltip",
    de: "Auf automatisch erzeugte Kurzinfo zurücksetzen",
    fr: "Revenir à l'infobulle générée automatiquement",
    it: "Ripristina la descrizione generata automaticamente",
    es: "Restablecer la descripción generada automáticamente",
  },
  use_for_slider: {
    en: "Use for slider", de: "Für Schieberegler verwenden",
    fr: "Utiliser pour le curseur", it: "Usa per il cursore",
    es: "Usar para el control deslizante",
  },
  pinned_in_yaml: {
    en: "Pinned in YAML — no button retargets it.",
    de: "In YAML festgelegt — keine Taste lenkt ihn um.",
    fr: "Fixé dans le YAML — aucune touche ne le réoriente.",
    it: "Fissato nello YAML — nessun tasto lo ridirige.",
    es: "Fijado en YAML — ningún botón lo redirige.",
  },
  set_under_advanced: {
    en: "— set under Advanced —", de: "— unter Erweitert festgelegt —",
    fr: "— défini sous Avancé —", it: "— impostato in Avanzate —",
    es: "— definido en Avanzado —",
  },

  // ── images and states ──────────────────────────────────────────────
  no_service_defined: {
    en: "No service defined. Assign this action to a button first.",
    de: "Kein Dienst definiert. Weise diese Aktion zuerst einer Taste zu.",
    fr: "Aucun service défini. Attribuez d'abord cette action à une touche.",
    it: "Nessun servizio definito. Assegna prima questa azione a un tasto.",
    es: "Ningún servicio definido. Asigna primero esta acción a un botón.",
  },

  // ── outcomes ───────────────────────────────────────────────────────
  saved: {
    en: "Saved ✓", de: "Gespeichert ✓", fr: "Enregistré ✓",
    it: "Salvato ✓", es: "Guardado ✓",
  },
  save_failed: {
    en: "Save failed: {error}", de: "Speichern fehlgeschlagen: {error}",
    fr: "Échec de l'enregistrement : {error}",
    it: "Salvataggio non riuscito: {error}",
    es: "Error al guardar: {error}",
  },
  failed: {
    en: "Failed: {error}", de: "Fehlgeschlagen: {error}",
    fr: "Échec : {error}", it: "Non riuscito: {error}",
    es: "Error: {error}",
  },
  add_page_failed: {
    en: "Failed to add page", de: "Seite konnte nicht hinzugefügt werden",
    fr: "Impossible d'ajouter la page", it: "Impossibile aggiungere la pagina",
    es: "No se ha podido añadir la página",
  },
  add_page_error: {
    en: "Error adding page: {error}",
    de: "Fehler beim Hinzufügen der Seite: {error}",
    fr: "Erreur lors de l'ajout de la page : {error}",
    it: "Errore durante l'aggiunta della pagina: {error}",
    es: "Error al añadir la página: {error}",
  },
  delete_page_failed: {
    en: "Failed to delete page", de: "Seite konnte nicht gelöscht werden",
    fr: "Impossible de supprimer la page", it: "Impossibile eliminare la pagina",
    es: "No se ha podido eliminar la página",
  },
  template_picker_failed: {
    en: "Failed to open template picker",
    de: "Vorlagenauswahl konnte nicht geöffnet werden",
    fr: "Impossible d'ouvrir le sélecteur de modèles",
    it: "Impossibile aprire il selettore di modelli",
    es: "No se ha podido abrir el selector de plantillas",
  },
  // ── slider card ────────────────────────────────────────────────────
  advanced: {
    en: "Advanced", de: "Erweitert", fr: "Avancé", it: "Avanzate", es: "Avanzado",
  },
  customised: {
    en: "customised", de: "angepasst", fr: "personnalisé",
    it: "personalizzato", es: "personalizado",
  },
  control: {
    en: "Control", de: "Regelgröße", fr: "Commande", it: "Controllo", es: "Control",
  },
  data_key: {
    en: "Data key", de: "Datenschlüssel", fr: "Clé de données",
    it: "Chiave dati", es: "Clave de datos",
  },
  sensitivity: {
    en: "Sensitivity", de: "Empfindlichkeit", fr: "Sensibilité",
    it: "Sensibilità", es: "Sensibilidad",
  },
  label: {
    en: "Label", de: "Beschriftung", fr: "Libellé", it: "Etichetta", es: "Etiqueta",
  },
  tooltip: {
    en: "Tooltip", de: "Kurzinfo", fr: "Infobulle", it: "Descrizione", es: "Descripción",
  },
  reset_control_defaults: {
    en: "Reset to {control} defaults",
    de: "Auf Standardwerte für {control} zurücksetzen",
    fr: "Rétablir les valeurs par défaut de {control}",
    it: "Ripristina i valori predefiniti di {control}",
    es: "Restablecer los valores predeterminados de {control}",
  },
  slider_range_hint: {
    en: "Read from the entity when you first touch, and clamped to this range on the way out.",
    de: "Wird beim ersten Berühren aus der Entität gelesen und auf dem Weg hinaus auf diesen Bereich begrenzt.",
    fr: "Lu depuis l'entité au premier contact, puis ramené à cette plage en sortie.",
    it: "Letto dall'entità al primo tocco e limitato a questo intervallo in uscita.",
    es: "Se lee de la entidad al primer contacto y se limita a este intervalo al salir.",
  },
  slider_plumbing_hint: {
    en: "The plumbing behind the control above. Attribute and Data key must share a scale — reading <code>brightness</code> (0–255) but writing <code>brightness_pct</code> (0–100) will misbehave.",
    de: "Der Unterbau der Regelgröße oben. Attribut und Datenschlüssel müssen dieselbe Skala verwenden — <code>brightness</code> (0–255) zu lesen, aber <code>brightness_pct</code> (0–100) zu schreiben, führt zu Fehlverhalten.",
    fr: "La mécanique derrière la commande ci-dessus. L'attribut et la clé de données doivent partager la même échelle — lire <code>brightness</code> (0–255) mais écrire <code>brightness_pct</code> (0–100) provoquera un dysfonctionnement.",
    it: "Il meccanismo dietro il controllo qui sopra. Attributo e chiave dati devono condividere la stessa scala — leggere <code>brightness</code> (0–255) ma scrivere <code>brightness_pct</code> (0–100) causerà malfunzionamenti.",
    es: "La mecánica tras el control de arriba. El atributo y la clave de datos deben compartir la misma escala — leer <code>brightness</code> (0–255) pero escribir <code>brightness_pct</code> (0–100) funcionará mal.",
  },
  slider_page_mechanics_hint: {
    en: "These are the page's mechanics, not {name}'s: when a button retargets the slider the remote re-derives the whole set from the live entity on every gesture, so there is nothing per-button to store here. Editing them changes the <b>{page_default}</b>, from here or from there.",
    de: "Dies sind die Mechanismen der Seite, nicht die von {name}: Lenkt eine Taste den Schieberegler um, leitet die Fernbedienung den gesamten Satz bei jeder Geste neu aus der laufenden Entität ab — hier gibt es also nichts pro Taste zu speichern. Eine Änderung wirkt auf den <b>{page_default}</b>, von hier wie von dort.",
    fr: "Ce sont les mécanismes de la page, pas ceux de {name} : lorsqu'une touche réoriente le curseur, la télécommande redérive l'ensemble depuis l'entité active à chaque geste, il n'y a donc rien à stocker par touche ici. Les modifier change la <b>{page_default}</b>, d'ici comme de là-bas.",
    it: "Questi sono i meccanismi della pagina, non quelli di {name}: quando un tasto ridirige il cursore il telecomando rideriva l'intero insieme dall'entità attiva a ogni gesto, quindi qui non c'è nulla da memorizzare per tasto. Modificarli cambia il <b>{page_default}</b>, da qui come da lì.",
    es: "Esta es la mecánica de la página, no la de {name}: cuando un botón redirige el control deslizante, el mando vuelve a derivar todo el conjunto de la entidad activa en cada gesto, así que aquí no hay nada que guardar por botón. Editarlos cambia el <b>{page_default}</b>, desde aquí o desde allí.",
  },
  slider_entity_hint: {
    en: "What the slider drives until a button retargets it. Leave empty to do nothing until you touch a device.",
    de: "Was der Schieberegler steuert, bis eine Taste ihn umlenkt. Leer lassen, damit nichts geschieht, bis du ein Gerät berührst.",
    fr: "Ce que le curseur commande jusqu'à ce qu'une touche le réoriente. Laissez vide pour qu'il ne fasse rien tant que vous ne touchez pas un appareil.",
    it: "Ciò che il cursore comanda finché un tasto non lo ridirige. Lascia vuoto perché non faccia nulla finché non tocchi un dispositivo.",
    es: "Lo que acciona el control deslizante hasta que un botón lo redirige. Déjalo vacío para que no haga nada hasta que toques un dispositivo.",
  },
  slider_factor_hint: {
    en: "At 1.0, touching one end of the track reaches the full range and touching the middle reaches half. Raise it to cover the range in less travel.",
    de: "Bei 1,0 erreicht eine Berührung am Ende der Bahn den vollen Bereich, in der Mitte die Hälfte. Höhere Werte decken den Bereich mit kürzerem Weg ab.",
    fr: "À 1,0, toucher une extrémité de la piste atteint toute la plage et le milieu la moitié. Augmentez la valeur pour couvrir la plage sur une course plus courte.",
    it: "A 1,0, toccare un'estremità della traccia raggiunge l'intero intervallo e il centro la metà. Aumentalo per coprire l'intervallo con meno corsa.",
    es: "En 1,0, tocar un extremo de la pista alcanza todo el intervalo y el centro, la mitad. Auméntelo para cubrir el intervalo con menos recorrido.",
  },
  slider_use_page_factor: {
    en: "Use the page value ({value})", de: "Seitenwert verwenden ({value})",
    fr: "Utiliser la valeur de la page ({value})",
    it: "Usa il valore della pagina ({value})",
    es: "Usar el valor de la página ({value})",
  },
  slider_pinned_hint: {
    en: "This page pins its slider, so no button can retarget it. Clear the slider's own entity under <b>{page_default}</b> to let buttons drive it.",
    de: "Diese Seite legt ihren Schieberegler fest, keine Taste kann ihn umlenken. Lösche die eigene Entität des Schiebereglers unter <b>{page_default}</b>, damit Tasten ihn steuern können.",
    fr: "Cette page fixe son curseur, aucune touche ne peut le réorienter. Effacez l'entité propre du curseur sous <b>{page_default}</b> pour que les touches puissent le commander.",
    it: "Questa pagina fissa il suo cursore, nessun tasto può ridirigerlo. Cancella l'entità propria del cursore sotto <b>{page_default}</b> per far sì che i tasti lo comandino.",
    es: "Esta página fija su control deslizante, ningún botón puede redirigirlo. Borra la entidad propia del control deslizante en <b>{page_default}</b> para que los botones puedan accionarlo.",
  },
  slider_points_here: {
    en: "Touching {name} points this slider here.",
    de: "Eine Berührung von {name} richtet diesen Schieberegler hierher.",
    fr: "Toucher {name} oriente ce curseur ici.",
    it: "Toccare {name} punta questo cursore qui.",
    es: "Tocar {name} dirige este control deslizante aquí.",
  },
  slider_empty_hint: {
    en: "Empty, so this button leaves the slider alone — <b>{page_default}</b> stands.",
    de: "Leer, diese Taste lässt den Schieberegler also unberührt — <b>{page_default}</b> gilt.",
    fr: "Vide, cette touche laisse donc le curseur tranquille — <b>{page_default}</b> s'applique.",
    it: "Vuoto, quindi questo tasto lascia stare il cursore — vale <b>{page_default}</b>.",
    es: "Vacío, así que este botón deja en paz el control deslizante — rige <b>{page_default}</b>.",
  },
  edit_page_default_title: {
    en: "Edit this button's page default instead",
    de: "Stattdessen den Seitenstandard dieser Taste bearbeiten",
    fr: "Modifier plutôt la valeur par défaut de la page pour cette touche",
    it: "Modifica invece il predefinito della pagina per questo tasto",
    es: "Editar en su lugar el predeterminado de la página de este botón",
  },
  // The card subtitle that says which page's selection this override belongs
  // to. The name is wrapped in <b> by the caller and passed in as the
  // placeholder rather than sitting in the template, because the word order
  // around it moves between languages -- in German the name lands before the
  // verb, so a <b> fixed in the English shape would emphasise the wrong span.
  context_when_selected: {
    en: "when {name} is selected",
    de: "wenn {name} ausgewählt ist",
    fr: "lorsque {name} est sélectionné",
    it: "quando {name} è selezionato",
    es: "cuando {name} está seleccionado",
  },

  // ── icon hints ─────────────────────────────────────────────────────
  icon_showing_none: {
    en: "Showing no icon.", de: "Es wird kein Symbol angezeigt.",
    fr: "Aucune icône affichée.", it: "Nessuna icona mostrata.",
    es: "No se muestra ningún icono.",
  },
  icon_clear_to_hide: {
    en: "Clear it to show no icon.", de: "Leeren, um kein Symbol anzuzeigen.",
    fr: "Effacez-la pour n'afficher aucune icône.",
    it: "Cancellala per non mostrare alcuna icona.",
    es: "Bórrelo para no mostrar ningún icono.",
  },
  icon_leave_empty: {
    en: "Leave empty to show no icon — a slider that follows the selection has no fixed control to borrow one from.",
    de: "Leer lassen, um kein Symbol anzuzeigen — ein Schieberegler, der der Auswahl folgt, hat keine feste Regelgröße, von der er eines borgen könnte.",
    fr: "Laissez vide pour n'afficher aucune icône — un curseur qui suit la sélection n'a pas de commande fixe à laquelle en emprunter une.",
    it: "Lascia vuoto per non mostrare alcuna icona — un cursore che segue la selezione non ha un controllo fisso da cui prenderne una.",
    es: "Déjelo vacío para no mostrar ningún icono — un control deslizante que sigue a la selección no tiene un control fijo del que tomar uno.",
  },
  icon_nothing_chosen: {
    en: "Nothing is chosen, so there is no control to borrow an icon from — pick one here, or set the slider's entity first.",
    de: "Es ist nichts gewählt, also gibt es keine Regelgröße, von der ein Symbol geborgt werden könnte — wähle hier eines oder setze zuerst die Entität des Schiebereglers.",
    fr: "Rien n'est sélectionné, il n'y a donc aucune commande à laquelle emprunter une icône — choisissez-en une ici, ou définissez d'abord l'entité du curseur.",
    it: "Non è selezionato nulla, quindi non c'è un controllo da cui prendere un'icona — scegline una qui o imposta prima l'entità del cursore.",
    es: "No hay nada seleccionado, así que no hay ningún control del que tomar un icono — elige uno aquí o define primero la entidad del control deslizante.",
  },
  label_own_hint: {
    en: "{name}'s own — leave empty for <b>{auto}</b>.",
    de: "Eigene von {name} — leer lassen für <b>{auto}</b>.",
    fr: "Propre à {name} — laissez vide pour <b>{auto}</b>.",
    it: "Propria di {name} — lascia vuoto per <b>{auto}</b>.",
    es: "Propia de {name} — déjelo vacío para <b>{auto}</b>.",
  },

  visual_editor_unavailable: {    en: "Visual editor unavailable. Visit Settings → Automations first, then reload this page.",
    de: "Visueller Editor nicht verfügbar. Ruf zuerst Einstellungen → Automatisierungen auf und lade diese Seite dann neu.",
    fr: "Éditeur visuel indisponible. Ouvrez d'abord Paramètres → Automatisations, puis rechargez cette page.",
    it: "Editor visuale non disponibile. Apri prima Impostazioni → Automazioni, poi ricarica questa pagina.",
    es: "Editor visual no disponible. Abre primero Ajustes → Automatizaciones y vuelve a cargar esta página.",
  },

  // ── icon field, under a context ────────────────────────────────────
  ctx_icon_own: {
    en: "{name}'s own — shown while it holds the slider. ",
    de: "Eigenes von {name} — wird angezeigt, solange es den Schieberegler hält. ",
    fr: "Propre à {name} — affichée tant qu'il détient le curseur. ",
    it: "Propria di {name} — mostrata finché tiene il cursore. ",
    es: "Propio de {name} — se muestra mientras mantiene el control deslizante. ",
  },
  ctx_icon_none: {
    en: "Showing no icon.", de: "Es wird kein Symbol angezeigt.",
    fr: "Aucune icône n'est affichée.", it: "Non viene mostrata alcuna icona.",
    es: "No se muestra ningún icono.",
  },
  ctx_icon_clear: {
    en: "Clear it to show no icon.", de: "Leeren, um kein Symbol anzuzeigen.",
    fr: "Videz le champ pour n'afficher aucune icône.",
    it: "Svuotalo per non mostrare alcuna icona.",
    es: "Vacíelo para no mostrar ningún icono.",
  },
  ctx_icon_empty: {
    en: "Leave empty to show no icon.", de: "Leer lassen, um kein Symbol anzuzeigen.",
    fr: "Laissez vide pour n'afficher aucune icône.",
    it: "Lascia vuoto per non mostrare alcuna icona.",
    es: "Déjelo vacío para no mostrar ningún icono.",
  },

  // ── sensitivity, slider presets, validation ────────────────────────
  factor_own_hint: {
    en: "{name} has its own; the page uses {page}.",
    de: "{name} hat einen eigenen; die Seite verwendet {page}.",
    fr: "{name} a le sien ; la page utilise {page}.",
    it: "{name} ha il proprio; la pagina usa {page}.",
    es: "{name} tiene el suyo; la página usa {page}.",
  },
  factor_inherited_hint: {
    en: "Inherited from the page. Change it to give {name} its own.",
    de: "Von der Seite geerbt. Ändere ihn, um {name} einen eigenen zu geben.",
    fr: "Hérité de la page. Modifiez-le pour donner le sien à {name}.",
    it: "Ereditato dalla pagina. Modificalo per dare a {name} il proprio.",
    es: "Heredado de la página. Cámbielo para darle uno propio a {name}.",
  },
  pick_target_first: {
    en: "Pick a target entity first.",
    de: "Wähle zuerst eine Ziel-Entität.",
    fr: "Choisissez d'abord une entité cible.",
    it: "Scegli prima un'entità di destinazione.",
    es: "Elige primero una entidad de destino.",
  },
  slider_writes_range: {
    en: "Writes <code>{key}</code> between {min} and {max}.",
    de: "Schreibt <code>{key}</code> zwischen {min} und {max}.",
    fr: "Écrit <code>{key}</code> entre {min} et {max}.",
    it: "Scrive <code>{key}</code> tra {min} e {max}.",
    es: "Escribe <code>{key}</code> entre {min} y {max}.",
  },
  no_presets_for_domain: {
    en: "No presets for <code>{domain}</code> — configure it under Advanced.",
    de: "Keine Vorgaben für <code>{domain}</code> — richte es unter Erweitert ein.",
    fr: "Aucun préréglage pour <code>{domain}</code> — configurez-le sous Avancé.",
    it: "Nessun preset per <code>{domain}</code> — configuralo in Avanzate.",
    es: "No hay valores predefinidos para <code>{domain}</code> — configúrelo en Avanzado.",
  },
  no_actions_match: {
    en: 'No actions match "{filter}"', de: "Keine Aktionen passen zu „{filter}“",
    fr: "Aucune action ne correspond à « {filter} »",
    it: 'Nessuna azione corrisponde a "{filter}"',
    es: "Ninguna acción coincide con «{filter}»",
  },
  action_deleted_pages_failed: {
    en: "Action deleted, but these pages could not be updated: {pages}",
    de: "Aktion gelöscht, aber diese Seiten konnten nicht aktualisiert werden: {pages}",
    fr: "Action supprimée, mais ces pages n'ont pas pu être mises à jour : {pages}",
    it: "Azione eliminata, ma non è stato possibile aggiornare queste pagine: {pages}",
    es: "Acción eliminada, pero no se han podido actualizar estas páginas: {pages}",
  },
  control_stale: {
    en: "<code>{stored}</code> isn't available here — using <b>{control}</b>, {min}–{max}.",
    de: "<code>{stored}</code> ist hier nicht verfügbar — es wird <b>{control}</b> verwendet, {min}–{max}.",
    fr: "<code>{stored}</code> n'est pas disponible ici — utilisation de <b>{control}</b>, {min}–{max}.",
    it: "<code>{stored}</code> non è disponibile qui — viene usato <b>{control}</b>, {min}–{max}.",
    es: "<code>{stored}</code> no está disponible aquí — se usa <b>{control}</b>, {min}–{max}.",
  },
  this_button_controls: {
    en: "This button controls", de: "Diese Taste steuert",
    fr: "Cette touche commande", it: "Questo tasto controlla",
    es: "Este botón controla",
  },
  unknown_entity: {
    en: "Unknown entity <code>{entity}</code>.",
    de: "Unbekannte Entität <code>{entity}</code>.",
    fr: "Entité inconnue <code>{entity}</code>.",
    it: "Entità sconosciuta <code>{entity}</code>.",
    es: "Entidad desconocida <code>{entity}</code>.",
  },
  control_unsupported: {
    en: "<b>{name}</b> does not support {control} — this slider will do nothing. Pick another control.",
    de: "<b>{name}</b> unterstützt {control} nicht — dieser Schieberegler tut nichts. Wähle eine andere Regelgröße.",
    fr: "<b>{name}</b> ne prend pas en charge {control} — ce curseur ne fera rien. Choisissez une autre commande.",
    it: "<b>{name}</b> non supporta {control} — questo cursore non farà nulla. Scegli un altro controllo.",
    es: "<b>{name}</b> no admite {control} — este control deslizante no hará nada. Elige otro control.",
  },
  max_must_exceed_min: {
    en: "Max must be greater than Min, or the slider can never change anything.",
    de: "Max muss größer als Min sein, sonst kann der Schieberegler nie etwas ändern.",
    fr: "Max doit être supérieur à Min, sinon le curseur ne peut rien changer.",
    it: "Max deve essere maggiore di Min, altrimenti il cursore non può cambiare nulla.",
    es: "Máx debe ser mayor que Mín, de lo contrario el control deslizante nunca cambiará nada.",
  },
  // Two halves of one hint. The first is omitted while the template resolves to
  // nothing, so they are separate ids rather than a placeholder that would have
  // to carry its own trailing space and punctuation through five languages.
  label_now_reads: {
    en: "Now reads <b>{text}</b>. ", de: "Zeigt derzeit <b>{text}</b>. ",
    fr: "Affiche actuellement <b>{text}</b>. ",
    it: "Ora mostra <b>{text}</b>. ",
    es: "Ahora muestra <b>{text}</b>. ",
  },
  label_state_hint: {
    en: "<code>${_state}</code> follows the entity — replace it to fix the wording.",
    de: "<code>${_state}</code> folgt der Entität — ersetze es, um die Formulierung zu ändern.",
    fr: "<code>${_state}</code> suit l'entité — remplacez-le pour corriger la formulation.",
    it: "<code>${_state}</code> segue l'entità — sostituiscilo per correggere la formulazione.",
    es: "<code>${_state}</code> sigue a la entidad — sustitúyalo para corregir la redacción.",
  },
  label_media_hint: {
    en: "<code>${_device.media_title}</code> and <code>${_device.media_artist}</code> name the track — blank without a page player, or while nothing plays.",
    de: "<code>${_device.media_title}</code> und <code>${_device.media_artist}</code> nennen Titel und Interpret — ohne Player der Seite oder solange nichts läuft bleiben sie leer.",
    fr: "<code>${_device.media_title}</code> et <code>${_device.media_artist}</code> nomment le morceau — vides sans lecteur de page, ou tant que rien ne joue.",
    it: "<code>${_device.media_title}</code> e <code>${_device.media_artist}</code> indicano il brano — vuoti senza lettore della pagina o finché non suona nulla.",
    es: "<code>${_device.media_title}</code> y <code>${_device.media_artist}</code> nombran la pista — vacíos sin reproductor de página o mientras no suene nada.",
  },
  token_state_note: {
    en: "what the press does",
    de: "was der Druck bewirkt",
    fr: "ce que fait l'appui",
    it: "cosa fa la pressione",
    es: "lo que hace la pulsación",
  },
  token_name_note: {
    en: "the command's target",
    de: "das Ziel des Befehls",
    fr: "la cible de la commande",
    it: "il bersaglio del comando",
    es: "el objetivo del comando",
  },
  token_queue_next_song_note: {
    en: "the track Next moves to",
    de: "der Titel, zu dem Weiter springt",
    fr: "le morceau vers lequel Suivant passe",
    it: "il brano a cui passa Avanti",
    es: "la pista a la que salta Siguiente",
  },
  token_queue_next_artist_note: {
    en: "who plays it",
    de: "wer ihn spielt",
    fr: "qui le joue",
    it: "chi lo suona",
    es: "quién la toca",
  },
  token_queue_prev_song_note: {
    en: "the track Previous moves to",
    de: "der Titel, zu dem Zurück springt",
    fr: "le morceau vers lequel Précédent passe",
    it: "il brano a cui passa Indietro",
    es: "la pista a la que salta Anterior",
  },
  token_queue_prev_artist_note: {
    en: "who plays it",
    de: "wer ihn spielt",
    fr: "qui le joue",
    it: "chi lo suona",
    es: "quién la toca",
  },
  showcase_pages: {
    en: "Showcase", de: "Showcase", fr: "Vitrine", it: "Vetrina", es: "Escaparate",
  },
  showcase_pages_desc: {
    en: "Pages showing what tiles can do", de: "Seiten, die zeigen, was Kacheln können",
    fr: "Pages montrant ce que les tuiles savent faire",
    it: "Pagine che mostrano cosa sanno fare i riquadri",
    es: "Páginas que muestran lo que pueden hacer los botones",
  },
  sonos_categories: {
    en: "Categories", de: "Kategorien", fr: "Catégories", it: "Categorie", es: "Categorías",
  },
  sonos_categories_desc: {
    en: "One page per kind of favourite: radio, playlists, albums, audiobooks and more",
    de: "Eine Seite je Art von Favorit: Radio, Playlists, Alben, Hörbücher und mehr",
    fr: "Une page par type de favori : radio, playlists, albums, livres audio et plus",
    it: "Una pagina per tipo di preferito: radio, playlist, album, audiolibri e altro",
    es: "Una página por tipo de favorito: radio, listas, álbumes, audiolibros y más",
  },
  random_pages: {
    en: "Random pages", de: "Zufallsseiten", fr: "Pages aléatoires",
    it: "Pagine casuali", es: "Páginas aleatorias",
  },
  random_pages_desc: {
    en: "Test pages titled \"page <id>\", with random icons on every button.",
    de: "Testseiten mit dem Titel „page <id>“ und zufälligen Icons auf allen Tasten.",
    fr: "Pages de test intitulées « page <id> », avec des icônes aléatoires sur chaque touche.",
    it: "Pagine di prova intitolate \"page <id>\", con icone casuali su ogni tasto.",
    es: "Páginas de prueba tituladas \"page <id>\", con iconos aleatorios en cada botón.",
  },
  random_pages_count: {
    en: "Number of pages", de: "Anzahl der Seiten", fr: "Nombre de pages",
    it: "Numero di pagine", es: "Número de páginas",
  },
  random_pages_images: {
    en: "Number of different images", de: "Anzahl verschiedener Bilder",
    fr: "Nombre d'images différentes", it: "Numero di immagini diverse",
    es: "Número de imágenes distintas",
  },
  random_pages_tooltip: {
    en: "Tooltip (same on every button)", de: "Tooltip (auf allen Tasten gleich)",
    fr: "Infobulle (identique sur chaque touche)", it: "Tooltip (uguale su ogni tasto)",
    es: "Tooltip (igual en cada botón)",
  },
  random_pages_create: {
    en: "Create", de: "Erstellen", fr: "Créer", it: "Crea", es: "Crear",
  },
  random_pages_added: {
    en: "{count} pages added", de: "{count} Seiten hinzugefügt", fr: "{count} pages ajoutées",
    it: "{count} pagine aggiunte", es: "{count} páginas añadidas",
  },
  random_pages_failed: {
    en: "Could not add the pages: {error}", de: "Seiten konnten nicht hinzugefügt werden: {error}",
    fr: "Impossible d'ajouter les pages : {error}", it: "Impossibile aggiungere le pagine: {error}",
    es: "No se pudieron añadir las páginas: {error}",
  },
  title_device_hint: {
    en: "<code>${_device}</code> shows the name of this page's device, <code>${_device.…}</code> one of its attributes (e.g. <code>${_device.volume_level}</code>).",
    de: "<code>${_device}</code> zeigt den Namen des Geräts dieser Seite, <code>${_device.…}</code> eines seiner Attribute (z. B. <code>${_device.volume_level}</code>).",
    fr: "<code>${_device}</code> affiche le nom de l'appareil de cette page, <code>${_device.…}</code> l'un de ses attributs (p. ex. <code>${_device.volume_level}</code>).",
    it: "<code>${_device}</code> mostra il nome del dispositivo di questa pagina, <code>${_device.…}</code> uno dei suoi attributi (ad es. <code>${_device.volume_level}</code>).",
    es: "<code>${_device}</code> muestra el nombre del dispositivo de esta página, <code>${_device.…}</code> uno de sus atributos (p. ej. <code>${_device.volume_level}</code>).",
  },
  variable_hint: {
    en: "<code>${sensor.…}</code> shows that entity's current value, <code>${sensor.….attribute}</code> one of its attributes.",
    de: "<code>${sensor.…}</code> zeigt den aktuellen Wert dieser Entität, <code>${sensor.….attribut}</code> eines ihrer Attribute.",
    fr: "<code>${sensor.…}</code> affiche la valeur actuelle de cette entité, <code>${sensor.….attribut}</code> l'un de ses attributs.",
    it: "<code>${sensor.…}</code> mostra il valore attuale di quell'entità, <code>${sensor.….attributo}</code> uno dei suoi attributi.",
    es: "<code>${sensor.…}</code> muestra el valor actual de esa entidad, <code>${sensor.….atributo}</code> uno de sus atributos.",
  },
  label_name_hint: {
    en: "<code>${_name}</code> is replaced by what the button opens.",
    de: "<code>${_name}</code> wird durch das ersetzt, was die Taste öffnet.",
    fr: "<code>${_name}</code> est remplacé par ce que la touche ouvre.",
    it: "<code>${_name}</code> viene sostituito da ciò che il tasto apre.",
    es: "<code>${_name}</code> se sustituye por lo que abre el botón.",
  },
  tooltip_needs_action: {
    en: "Add an action first — a tooltip on its own is not stored.",
    de: "Füge zuerst eine Aktion hinzu — ein Tooltip allein wird nicht gespeichert.",
    fr: "Ajoutez d'abord une action — une infobulle seule n'est pas enregistrée.",
    it: "Aggiungi prima un'azione — un tooltip da solo non viene salvato.",
    es: "Añade primero una acción — una información sobre herramientas por sí sola no se guarda.",
  },

  // ── page targets that no longer resolve ────────────────────────────
  // The subtitle under an action in the library, not the warning on a button
  // that has none -- that one is `no_service_defined`, and sharing the id made
  // this shorter phrase silently win over the longer sentence.
  no_service_subtitle: {
    en: "No service defined", de: "Kein Dienst definiert",
    fr: "Aucun service défini", it: "Nessun servizio definito",
    es: "Ningún servicio definido",
  },
  goto_no_page: {
    en: "No page is selected, so this button will do nothing.",
    de: "Es ist keine Seite ausgewählt, daher tut diese Taste nichts.",
    fr: "Aucune page n'est sélectionnée, ce bouton ne fera donc rien.",
    it: "Non è selezionata alcuna pagina, quindi questo pulsante non farà nulla.",
    es: "No hay ninguna página seleccionada, por lo que este botón no hará nada.",
  },
  goto_name_id_disagree: {
    en: "No page called {name} has the id {id}. This button will do nothing until the two agree.",
    de: "Keine Seite namens {name} hat die Kennung {id}. Diese Taste tut nichts, bis beide übereinstimmen.",
    fr: "Aucune page nommée {name} n'a l'identifiant {id}. Ce bouton ne fera rien tant que les deux ne concordent pas.",
    it: "Nessuna pagina chiamata {name} ha l'id {id}. Questo pulsante non farà nulla finché i due non concordano.",
    es: "Ninguna página llamada {name} tiene el id {id}. Este botón no hará nada hasta que ambos coincidan.",
  },
  goto_name_gone: {
    en: "There is no page called {name} any more, so this button will do nothing.",
    de: "Es gibt keine Seite namens {name} mehr, daher tut diese Taste nichts.",
    fr: "Il n'y a plus de page nommée {name}, ce bouton ne fera donc rien.",
    it: "Non esiste più una pagina chiamata {name}, quindi questo pulsante non farà nulla.",
    es: "Ya no existe ninguna página llamada {name}, por lo que este botón no hará nada.",
  },
  goto_ambiguous_name: {
    en: "{count} pages are called {name}, so this button cannot tell which one you mean and will do nothing. Rename one, or pick the page again to store its id.",
    de: "{count} Seiten heißen {name}, daher kann diese Taste nicht erkennen, welche gemeint ist, und tut nichts. Benenne eine um oder wähle die Seite erneut, um ihre Kennung zu speichern.",
    fr: "{count} pages s'appellent {name}, ce bouton ne peut donc pas savoir laquelle vous voulez et ne fera rien. Renommez-en une, ou choisissez à nouveau la page pour enregistrer son identifiant.",
    it: "{count} pagine si chiamano {name}, quindi questo pulsante non può sapere quale intendi e non farà nulla. Rinominane una, oppure scegli di nuovo la pagina per salvarne l'id.",
    es: "{count} páginas se llaman {name}, por lo que este botón no puede saber cuál quieres y no hará nada. Cambia el nombre de una, o elige la página de nuevo para guardar su id.",
  },
  goto_id_gone: {
    en: "There is no page with the id {id} any more, so this button will do nothing.",
    de: "Es gibt keine Seite mit der Kennung {id} mehr, daher tut diese Taste nichts.",
    fr: "Il n'y a plus de page avec l'identifiant {id}, ce bouton ne fera donc rien.",
    it: "Non esiste più una pagina con l'id {id}, quindi questo pulsante non farà nulla.",
    es: "Ya no existe ninguna página con el id {id}, por lo que este botón no hará nada.",
  },

  // ── hub and device pickers ─────────────────────────────────────────
  hubs_load_failed: {
    en: "Could not load hubs: {error}", de: "Hubs konnten nicht geladen werden: {error}",
    fr: "Impossible de charger les hubs : {error}",
    it: "Impossibile caricare gli hub: {error}",
    es: "No se han podido cargar los concentradores: {error}",
  },
  no_hub_found: {
    en: "No {integration} hub found. Set up the {integration} integration first.",
    de: "Kein {integration}-Hub gefunden. Richte zuerst die Integration {integration} ein.",
    fr: "Aucun hub {integration} trouvé. Configurez d'abord l'intégration {integration}.",
    it: "Nessun hub {integration} trovato. Configura prima l'integrazione {integration}.",
    es: "No se ha encontrado ningún concentrador {integration}. Configura primero la integración {integration}.",
  },
  // Stands in for a template that does not name its integration. A placeholder
  // cannot carry this one: "the required integration" substituted into "Set up
  // the {integration} integration first" reads "the the required integration
  // integration", which is what it did before it was split in two.
  no_hub_found_generic: {
    en: "No hub found. Set up the required integration first.",
    de: "Kein Hub gefunden. Richte zuerst die benötigte Integration ein.",
    fr: "Aucun hub trouvé. Configurez d'abord l'intégration requise.",
    it: "Nessun hub trovato. Configura prima l'integrazione richiesta.",
    es: "No se ha encontrado ningún concentrador. Configura primero la integración necesaria.",
  },
  devices_load_failed: {
    en: "Could not load devices: {error}",
    de: "Geräte konnten nicht geladen werden: {error}",
    fr: "Impossible de charger les appareils : {error}",
    it: "Impossibile caricare i dispositivi: {error}",
    es: "No se han podido cargar los dispositivos: {error}",
  },
  remote_load_failed: {
    en: "Could not load this remote: {error}",
    de: "Diese Fernbedienung konnte nicht geladen werden: {error}",
    fr: "Impossible de charger cette télécommande : {error}",
    it: "Impossibile caricare questo telecomando: {error}",
    es: "No se ha podido cargar este mando: {error}",
  },
  no_matching_devices: {
    en: "No matching devices found. Set up the {integration} integration first.",
    de: "Keine passenden Geräte gefunden. Richte zuerst die Integration {integration} ein.",
    fr: "Aucun appareil correspondant trouvé. Configurez d'abord l'intégration {integration}.",
    it: "Nessun dispositivo corrispondente trovato. Configura prima l'integrazione {integration}.",
    es: "No se han encontrado dispositivos coincidentes. Configura primero la integración {integration}.",
  },
  no_matching_devices_generic: {
    en: "No matching devices found. Set up the required integration first.",
    de: "Keine passenden Geräte gefunden. Richte zuerst die benötigte Integration ein.",
    fr: "Aucun appareil correspondant trouvé. Configurez d'abord l'intégration requise.",
    it: "Nessun dispositivo corrispondente trovato. Configura prima l'integrazione richiesta.",
    es: "No se han encontrado dispositivos coincidentes. Configura primero la integración necesaria.",
  },

  // ── confirmations and tooltips ─────────────────────────────────────
  // The name goes in the title, not the body. Repeating "Delete page" in both
  // made the dialog say the same thing twice; the title asks the question and
  // the body is left to say only what is lost, which is the part WCAG 3.3.4
  // actually cares about.
  delete_page_title: {
    en: "Delete {name}?",
    de: "{name} löschen?",
    fr: "Supprimer {name} ?",
    it: "Eliminare {name}?",
    es: "¿Eliminar {name}?",
  },
  // Two messages rather than one with a count of zero: "and its 0 configured
  // buttons" reads as a bug, and 3.3.4 asks that the user be told what they
  // are destroying, not that every deletion sound equally grave.
  delete_page_confirm: {
    en: "This page and its {n} configured button(s) will be permanently deleted.",
    de: "Diese Seite und ihre {n} konfigurierte(n) Taste(n) werden endgültig gelöscht.",
    fr: "Cette page et ses {n} touche(s) configurée(s) seront définitivement supprimées.",
    it: "Questa pagina e i suoi {n} tasto/i configurato/i verranno eliminati definitivamente.",
    es: "Esta página y sus {n} botón(es) configurado(s) se eliminarán permanentemente.",
  },
  // Appended to the delete confirmation of a page a template brought
  // subpages with: they are reachable only from it, so they go too.
  delete_page_subpages: {
    en: "Its {count} subpages, which only it leads to, are deleted with it.",
    de: "Ihre {count} Unterseiten, zu denen nur sie führt, werden mit gelöscht.",
    fr: "Ses {count} sous-pages, auxquelles elle seule mène, sont supprimées avec elle.",
    it: "Le sue {count} sottopagine, a cui porta solo lei, vengono eliminate con essa.",
    es: "Sus {count} subpáginas, a las que solo ella lleva, se eliminan con ella.",
  },
  delete_page_subpages_one: {
    en: "Its subpage, which only it leads to, is deleted with it.",
    de: "Ihre Unterseite, zu der nur sie führt, wird mit gelöscht.",
    fr: "Sa sous-page, à laquelle elle seule mène, est supprimée avec elle.",
    it: "La sua sottopagina, a cui porta solo lei, viene eliminata con essa.",
    es: "Su subpágina, a la que solo ella lleva, se elimina con ella.",
  },
  delete_page_confirm_empty: {
    en: "This page will be permanently deleted.",
    de: "Diese Seite wird endgültig gelöscht.",
    fr: "Cette page sera définitivement supprimée.",
    it: "Questa pagina verrà eliminata definitivamente.",
    es: "Esta página se eliminará permanentemente.",
  },
  page_deleted: {
    en: 'Page "{name}" deleted',
    de: "Seite „{name}“ gelöscht",
    fr: "Page « {name} » supprimée",
    it: "Pagina \"{name}\" eliminata",
    es: "Página «{name}» eliminada",
  },
  delete_action_confirm: {
    en: 'Delete action "{name}"?',
    de: "Aktion „{name}“ löschen?",
    fr: "Supprimer l'action « {name} » ?",
    it: "Eliminare l'azione \"{name}\"?",
    es: "¿Eliminar la acción «{name}»?",
  },

  // ── names for assistive technology ─────────────────────────────────
  // Read aloud, not shown. The face reports "configured" with colour, which a
  // screen reader cannot convey, so the state has to join the name.
  a11y_btn_configured: {
    en: "{name}, assigned", de: "{name}, belegt",
    fr: "{name}, attribuée", it: "{name}, assegnato",
    es: "{name}, asignado",
  },
  a11y_btn_empty: {
    en: "{name}, not assigned", de: "{name}, nicht belegt",
    fr: "{name}, non attribuée", it: "{name}, non assegnato",
    es: "{name}, sin asignar",
  },
  // A button with no label of its own is named from its key, which alone is a
  // bare token: a reader said "9" or "power" and "Settings for 9" afterwards.
  // Only the fallback is prefixed -- a name the user chose is used as given.
  a11y_btn_fallback: {
    en: "Button {name}", de: "Taste {name}", fr: "Touche {name}",
    it: "Tasto {name}", es: "Botón {name}",
  },
  // The vertical slider. Drawn by the same loop as the shapes, so it used to
  // take the "Button {name}" fallback and was announced "Button Slider
  // vertical" -- the storage key, and the wrong control word for a slider.
  a11y_slider: {
    en: "Slider", de: "Schieberegler", fr: "Curseur",
    it: "Cursore", es: "Control deslizante",
  },
  // The title strip. It sits on the face among the buttons and is drawn by the
  // same loop, but it is the Page Settings control and not a button, so the
  // "configured / empty" phrasing the shapes get would describe it wrongly --
  // there is nothing to assign to it.
  a11y_page_title: {
    en: "Page title", de: "Seitentitel", fr: "Titre de la page",
    it: "Titolo della pagina", es: "Título de la página",
  },
  // The name a reader hears: which page, and where it sits. The fill count
  // rides on aria-describedby instead, being supplementary.
  page_name_pos: {
    en: "{name}, page {n} of {m}",
    de: "{name}, Seite {n} von {m}",
    fr: "{name}, page {n} sur {m}",
    it: "{name}, pagina {n} di {m}",
    es: "{name}, página {n} de {m}",
  },
  // The supplementary half, announced after the name and skippable.
  page_fill_desc: {
    en: "{filled} of {total} buttons assigned",
    de: "{filled} von {total} Tasten belegt",
    fr: "{filled} touches sur {total} attribuées",
    it: "{filled} di {total} tasti assegnati",
    es: "{filled} de {total} botones asignados",
  },
  // How a page is named wherever it is shown: its place in the run and its
  // id, with the title on a line of its own (see `_pagePosition`).
  page_position: {
    en: "Page {n}/{m} (#{id})", de: "Seite {n}/{m} (#{id})", fr: "Page {n}/{m} (#{id})",
    it: "Pagina {n}/{m} (#{id})", es: "Página {n}/{m} (#{id})",
  },
  // "Open {name}", not "Open page {name}": the name already carries the word
  // when it falls back to page_fallback, and said "Open page Page 1".
  a11y_open_page: {
    en: "Open {name}", de: "{name} öffnen", fr: "Ouvrir {name}",
    it: "Apri {name}", es: "Abrir {name}",
  },
  a11y_delete_page: {
    en: "Delete {name}", de: "{name} löschen", fr: "Supprimer {name}",
    it: "Elimina {name}", es: "Eliminar {name}",
  },
  // Folded into a page's spoken name so a subpage announces itself the same
  // way it names itself elsewhere ("make_subpage" / "Unterseite").
  a11y_subpage: {
    en: "subpage", de: "Unterseite", fr: "sous-page",
    it: "sottopagina", es: "subpágina",
  },
  // The name of a page with no title of its own. Was a hardcoded English
  // "Page N" inside a lang-scoped tree, so a German reader spoke it as German.
  page_fallback: {
    en: "Page {n}", de: "Seite {n}", fr: "Page {n}",
    it: "Pagina {n}", es: "Página {n}",
  },
};

/** The five languages we carry; anything else falls back to English. */
export const LANGS = ["en", "de", "fr", "it", "es"];

export const I18nMixin = {
  /** The base language Home Assistant is set to, e.g. `de` for `de-DE`. */
  _lang() {
    const raw = this._hass?.locale?.language || this._hass?.language || "en";
    const base = String(raw).toLowerCase().split(/[-_]/)[0];
    return LANGS.includes(base) ? base : "en";
  },

  /** A message that names the thing when there is a name, and falls back to the
   *  `<id>_generic` wording when there is not -- rather than interpolating an
   *  empty string and announcing "Editing ". */
  _tNamed(id, name) {
    return name ? this._t(id, { name }) : this._t(`${id}_generic`);
  },

  /** A count's wording, singular when there is one of it. `{count} templates`
   *  otherwise reads "1 templates", which no language is. */
  _tCount(id, count) {
    return count === 1 ? this._t(`${id}_one`) : this._t(id, { count });
  },

  /**
   * One user-visible phrase, translated and filled in.
   *
   * Home Assistant is asked first and believed only when it answers: an
   * unloaded fragment returns "", and silently rendering that would blank the
   * label rather than fall back. Unknown ids return the id itself, which is
   * ugly on screen on purpose — a blank is easy to miss in review.
   */
  _t(id, vars) {
    const entry = STRINGS[id];
    let text = "";
    if (entry?.ha) {
      const answer = this._hass?.localize?.(entry.ha);
      if (typeof answer === "string" && answer) text = answer;
    }
    if (!text) text = entry ? (entry[this._lang()] || entry.en || id) : id;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value ?? ""));
      }
    }
    return text;
  },
};
