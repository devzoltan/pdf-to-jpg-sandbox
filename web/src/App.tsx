import { useCallback, useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import { ConvertError, convertPdf, Phase, PageImage } from './api';
import { applyLang, detectLang, errorText, Lang, LANGS, TEXTS } from './i18n';

type State =
  | { kind: 'idle' }
  | { kind: 'busy'; phase: Phase; fileName: string }
  | { kind: 'done'; fileName: string; pages: PageImage[] }
  | { kind: 'error'; code: string };

const pad = (n: number) => String(n).padStart(3, '0');

function looksLikePdf(f: File): boolean {
  return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
}

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = TEXTS[lang];
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pagesRef = useRef<PageImage[]>([]);
  const zipUrlRef = useRef<string | null>(null);
  const busy = state.kind === 'busy';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewerTriggerRef = useRef<HTMLElement | null>(null);
  const [viewer, setViewer] = useState<{ page: PageImage; actual: boolean } | null>(null);

  useEffect(() => applyLang(lang, TEXTS[lang].title), [lang]);

  /** Releases all Blobs/object URLs of the previous result. */
  const releaseResult = useCallback(() => {
    for (const p of pagesRef.current) URL.revokeObjectURL(p.url);
    pagesRef.current = [];
    if (zipUrlRef.current) URL.revokeObjectURL(zipUrlRef.current);
    zipUrlRef.current = null;
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseResult();
    },
    [releaseResult],
  );

  const start = useCallback(
    async (file: File) => {
      if (abortRef.current) return; // no double starts
      releaseResult();
      if (!looksLikePdf(file)) {
        setState({ kind: 'error', code: 'CLIENT_NOT_PDF' });
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ kind: 'busy', phase: 'uploading', fileName: file.name });
      try {
        const pages = await convertPdf(file, controller.signal, (phase) =>
          setState({ kind: 'busy', phase, fileName: file.name }),
        );
        if (controller.signal.aborted) {
          for (const p of pages) URL.revokeObjectURL(p.url);
          return;
        }
        pagesRef.current = pages;
        setState({ kind: 'done', fileName: file.name, pages });
      } catch (e) {
        setState({ kind: 'error', code: e instanceof ConvertError ? e.code : 'WORKER_FAILED' });
      } finally {
        abortRef.current = null;
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [releaseResult],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    releaseResult();
    if (inputRef.current) inputRef.current.value = '';
    setState({ kind: 'idle' });
  }, [releaseResult]);

  const downloadZip = useCallback(() => {
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    Promise.all(pagesRef.current.map(async (p) => [p.page, new Uint8Array(await p.blob.arrayBuffer())] as const)).then(
      (entries) => {
        for (const [n, data] of entries) files[t.pageFile(pad(n))] = [data, { level: 0 }];
        const zip = zipSync(files);
        if (zipUrlRef.current) URL.revokeObjectURL(zipUrlRef.current);
        zipUrlRef.current = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = zipUrlRef.current;
        a.download = t.zipName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    );
  }, [t]);

  const openViewer = (page: PageImage, trigger: HTMLElement) => {
    viewerTriggerRef.current = trigger;
    setViewer({ page, actual: false });
  };
  useEffect(() => {
    if (viewer && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
  }, [viewer]);
  /** After closing (X, Esc, click outside) return focus to the preview that opened the viewer. */
  const onViewerClosed = () => {
    // The 'close' event is dispatched asynchronously. If the viewer was reopened in the meantime,
    // this event is stale and must not clear the newly opened view.
    if (dialogRef.current?.open) return;
    setViewer(null);
    const trigger = viewerTriggerRef.current;
    viewerTriggerRef.current = null;
    trigger?.focus();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const files = e.dataTransfer.files;
    if (files.length !== 1) {
      setState({ kind: 'error', code: 'CLIENT_ONE_FILE' });
      return;
    }
    void start(files[0]!);
  };

  return (
    <main className="app">
      <header>
        <div className="title-row">
          <h1>{t.title}</h1>
          <div className="lang" role="group" aria-label={t.language}>
            {LANGS.map((l) => (
              <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <p className="sub">{t.subtitle}</p>
      </header>

      {(state.kind === 'idle' || state.kind === 'error') && (
        <section
          className={`drop${dragOver ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          data-testid="dropzone"
        >
          <input
            ref={inputRef}
            id="file"
            type="file"
            accept="application/pdf,.pdf"
            className="visually-hidden"
            tabIndex={-1}
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void start(f);
            }}
          />
          <button type="button" className="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {t.choose}
          </button>
          <p>{t.dropHere}</p>
          <p className="hint">{t.hint}</p>
        </section>
      )}

      <div role="status" aria-live="polite" className="status">
        {state.kind === 'busy' && (
          <div className="busy">
            <span className="spinner" aria-hidden="true" />
            <span>{t.phase[state.phase]}</span>
          </div>
        )}
        {state.kind === 'done' && <p>{t.done(state.pages.length, state.fileName)}</p>}
      </div>

      {state.kind === 'error' && (
        <div role="alert" className="error">
          {errorText(t, state.code)}
        </div>
      )}

      {state.kind === 'busy' && (
        <div className="actions">
          <button type="button" onClick={reset}>
            {t.cancel}
          </button>
        </div>
      )}

      {state.kind === 'done' && (
        <>
          <div className="actions">
            <button type="button" className="primary" onClick={reset}>
              {t.newPdf}
            </button>
            {state.pages.length > 1 && (
              <button type="button" onClick={downloadZip}>
                {t.zip}
              </button>
            )}
          </div>
          <ol className="pages" aria-label={t.previewList}>
            {state.pages.map((p) => (
              <li key={p.page} className="page" data-page={p.page}>
                <figure>
                  <button
                    type="button"
                    className="thumb"
                    aria-label={t.enlarge(p.page)}
                    onClick={(e) => openViewer(p, e.currentTarget)}
                  >
                    <img src={p.url} alt={t.pageAlt(p.page)} width={p.width} height={p.height} loading="lazy" />
                  </button>
                  <figcaption>
                    {t.pageOf(p.page, state.pages.length)}
                    <span className="dim">
                      {' '}
                      · {p.width}×{p.height} px
                    </span>
                  </figcaption>
                </figure>
                <a className="button" href={p.url} download={t.pageFile(pad(p.page))}>
                  {t.downloadJpg}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}

      {/* Enlarged view: reuses the existing JPEG (object URL), no new conversion */}
      <dialog
        ref={dialogRef}
        className="viewer"
        aria-labelledby="viewer-title"
        onClose={onViewerClosed}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current.close();
        }}
      >
        {viewer && state.kind === 'done' && (
          <>
            <div className="viewer-bar">
              <h2 id="viewer-title">{t.pageOf(viewer.page.page, state.pages.length)}</h2>
              <button type="button" aria-pressed={viewer.actual} onClick={() => setViewer({ ...viewer, actual: !viewer.actual })}>
                {viewer.actual ? t.fitScreen : t.actualSize}
              </button>
              <a className="button" href={viewer.page.url} download={t.pageFile(pad(viewer.page.page))}>
                {t.downloadJpg}
              </a>
              <button type="button" className="close" aria-label={t.close} title={t.closeTitle} onClick={() => dialogRef.current?.close()}>
                ✕
              </button>
            </div>
            <div className="viewer-body" tabIndex={0} aria-label={t.imageArea}>
              <img
                src={viewer.page.url}
                alt={t.enlargedAlt(viewer.page.page)}
                width={viewer.page.width}
                height={viewer.page.height}
                className={viewer.actual ? 'actual' : 'fit'}
              />
            </div>
          </>
        )}
      </dialog>
    </main>
  );
}
