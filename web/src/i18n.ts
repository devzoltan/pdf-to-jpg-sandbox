export type Lang = 'en' | 'de';
export const LANGS: Lang[] = ['en', 'de'];

/** Language from the URL (`?lang=de`); English by default. Nothing is stored in the browser. */
export function detectLang(): Lang {
  const q = new URLSearchParams(window.location.search).get('lang');
  return q === 'de' ? 'de' : 'en';
}

/** Reflects the language in the URL (shareable, survives reload) and in the document. */
export function applyLang(lang: Lang, title: string): void {
  const url = new URL(window.location.href);
  if (lang === 'en') url.searchParams.delete('lang');
  else url.searchParams.set('lang', lang);
  window.history.replaceState(null, '', url);
  document.documentElement.lang = lang;
  document.title = title;
}

const en = {
  title: 'PDF to JPG',
  subtitle: 'View the pages of a PDF as JPG images and download them. Processing runs locally in an isolated environment; nothing is stored.',
  language: 'Language',
  choose: 'Choose PDF',
  dropHere: 'or drop a file here',
  hint: 'One PDF, max. 20 MiB and 50 pages.',
  phase: {
    uploading: 'Uploading file …',
    preparing: 'Updating the processing environment … (may take about a minute)',
    rendering: 'Processing …',
  },
  done: (n: number, name: string) => `Done: ${n} ${n === 1 ? 'page' : 'pages'} from “${name}”.`,
  cancel: 'Cancel',
  newPdf: 'New PDF',
  zip: 'Download all as ZIP',
  zipName: 'pages.zip',
  downloadJpg: 'Download JPG',
  pageFile: (p: string) => `page-${p}.jpg`,
  previewList: 'Page preview',
  pageAlt: (p: number) => `Page ${p}`,
  pageOf: (p: number, n: number) => `Page ${p} of ${n}`,
  enlarge: (p: number) => `Show page ${p} enlarged`,
  enlargedAlt: (p: number) => `Page ${p}, enlarged`,
  fitScreen: 'Fit to screen',
  actualSize: 'Actual size (1:1)',
  close: 'Close',
  closeTitle: 'Close (Esc)',
  imageArea: 'Image area',
  errors: {
    CLIENT_NOT_PDF: 'Please choose a PDF file.',
    CLIENT_ONE_FILE: 'Please drop exactly one PDF file.',
    BUSY: 'Another file is being processed. Please try again shortly.',
    EMPTY: 'The file is empty.',
    TOO_LARGE: 'The file is too large (max. 20 MiB).',
    NOT_PDF: 'The file is not a PDF.',
    INVALID_PDF: 'The PDF is damaged or cannot be read.',
    ENCRYPTED: 'The PDF is encrypted or password-protected and cannot be processed.',
    TOO_MANY_PAGES: 'The PDF has too many pages (max. 50).',
    OUTPUT_TOO_LARGE: 'The result would be too large (max. 50 MiB). Please use a smaller PDF.',
    IMAGE_TOO_LARGE: 'A page produced an image that is too large.',
    TIMEOUT: 'Processing took too long and was cancelled.',
    WORKER_FAILED: 'Processing failed.',
    UPDATE_FAILED: 'The processing environment could not be updated. Please check the internet connection and Docker.',
    UPDATE_TIMEOUT: 'Updating the processing environment took too long.',
    NETWORK: 'No connection to the server.',
    ABORTED: 'Processing was cancelled.',
    UNKNOWN: 'Unknown error. Please try again.',
  } as Record<string, string>,
};

export type Texts = typeof en;

const de: Texts = {
  title: 'PDF zu JPG',
  subtitle: 'Seiten einer PDF als JPG-Bilder ansehen und herunterladen. Die Verarbeitung erfolgt lokal in einer isolierten Umgebung; es wird nichts gespeichert.',
  language: 'Sprache',
  choose: 'PDF auswählen',
  dropHere: 'oder Datei hier ablegen',
  hint: 'Eine PDF, höchstens 20 MiB und 50 Seiten.',
  phase: {
    uploading: 'Datei wird übertragen …',
    preparing: 'Verarbeitungsumgebung wird aktualisiert … (kann etwa eine Minute dauern)',
    rendering: 'Verarbeitung läuft …',
  },
  done: (n, name) => `Fertig: ${n} ${n === 1 ? 'Seite' : 'Seiten'} aus „${name}“.`,
  cancel: 'Abbrechen',
  newPdf: 'Neue PDF',
  zip: 'Alle als ZIP herunterladen',
  zipName: 'seiten.zip',
  downloadJpg: 'JPG herunterladen',
  pageFile: (p) => `seite-${p}.jpg`,
  previewList: 'Seitenvorschau',
  pageAlt: (p) => `Seite ${p}`,
  pageOf: (p, n) => `Seite ${p} von ${n}`,
  enlarge: (p) => `Seite ${p} vergrößert anzeigen`,
  enlargedAlt: (p) => `Seite ${p}, vergrößert`,
  fitScreen: 'An Bildschirm anpassen',
  actualSize: 'Originalgröße (1:1)',
  close: 'Schließen',
  closeTitle: 'Schließen (Esc)',
  imageArea: 'Bildbereich',
  errors: {
    CLIENT_NOT_PDF: 'Bitte eine PDF-Datei auswählen.',
    CLIENT_ONE_FILE: 'Bitte genau eine PDF-Datei ablegen.',
    BUSY: 'Es läuft bereits eine Verarbeitung. Bitte in Kürze erneut versuchen.',
    EMPTY: 'Die Datei ist leer.',
    TOO_LARGE: 'Die Datei ist zu groß (höchstens 20 MiB).',
    NOT_PDF: 'Die Datei ist keine PDF-Datei.',
    INVALID_PDF: 'Die PDF-Datei ist beschädigt oder kann nicht gelesen werden.',
    ENCRYPTED: 'Die PDF-Datei ist verschlüsselt oder passwortgeschützt und kann nicht verarbeitet werden.',
    TOO_MANY_PAGES: 'Die PDF-Datei hat zu viele Seiten (höchstens 50).',
    OUTPUT_TOO_LARGE: 'Das Ergebnis wäre zu groß (höchstens 50 MiB). Bitte eine kleinere PDF verwenden.',
    IMAGE_TOO_LARGE: 'Eine Seite ergab ein unzulässig großes Bild.',
    TIMEOUT: 'Die Verarbeitung hat zu lange gedauert und wurde abgebrochen.',
    WORKER_FAILED: 'Die Verarbeitung ist fehlgeschlagen.',
    UPDATE_FAILED: 'Die Verarbeitungsumgebung konnte nicht aktualisiert werden. Bitte Internetverbindung und Docker prüfen.',
    UPDATE_TIMEOUT: 'Die Aktualisierung der Verarbeitungsumgebung hat zu lange gedauert.',
    NETWORK: 'Keine Verbindung zum Server.',
    ABORTED: 'Die Verarbeitung wurde abgebrochen.',
    UNKNOWN: 'Unbekannter Fehler. Bitte erneut versuchen.',
  },
};

export const TEXTS: Record<Lang, Texts> = { en, de };

export function errorText(t: Texts, code: string): string {
  return t.errors[code] ?? t.errors.UNKNOWN!;
}
