import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type ZoomMode = number | "width" | "height";

type PageProps = {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  scrollRoot: HTMLElement | null;
  onInverseSearch: (page: number, x: number, y: number) => void;
};

function PdfPage({ document, pageNumber, scale, scrollRoot, onInverseSearch }: PageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [nearViewport, setNearViewport] = useState(pageNumber === 1);

  useEffect(() => {
    if (!nearViewport) {
      setPage(null);
      return;
    }
    let active = true;
    void document.getPage(pageNumber).then((loaded) => active && setPage(loaded));
    return () => { active = false; };
  }, [document, nearViewport, pageNumber]);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setNearViewport(entry.isIntersecting);
      },
      { root: scrollRoot, rootMargin: "900px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRoot]);

  const viewport = useMemo(() => page?.getViewport({ scale }), [page, scale]);

  useEffect(() => {
    if (!page || !viewport || !nearViewport || !canvasRef.current) return;
    const canvas = canvasRef.current;
    // Render above CSS resolution even on non-Retina displays. PDF pages are
    // vector data, so supersampling keeps glyphs and diagrams crisp at zoom.
    const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    return () => {
      task.cancel();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [nearViewport, page, viewport]);

  const width = viewport?.width ?? 612 * scale;
  const height = viewport?.height ?? 792 * scale;
  return (
    <div
      ref={hostRef}
      className="pdf-page"
      data-page={pageNumber}
      style={{ width, height }}
      title="Doble clic para abrir esta posición en el código"
      onDoubleClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onInverseSearch(
          pageNumber,
          (event.clientX - bounds.left) / scale,
          (event.clientY - bounds.top) / scale,
        );
      }}
    >
      <canvas ref={canvasRef} aria-label={`Página ${pageNumber}`} />
    </div>
  );
}

type Props = {
  projectRoot: string;
  path: string;
  version: number;
  onSourceLocation: (location: SourceLocation) => void;
  onInverseSearchError: (message: string) => void;
};

export type SourceLocation = { path: string; line: number; column: number };

export default function PdfViewer({ projectRoot, path, version, onSourceLocation, onInverseSearchError }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<ZoomMode>(100);
  const [size, setSize] = useState({ width: 800, height: 700 });
  const [basePage, setBasePage] = useState({ width: 612, height: 792 });
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [inverseSearching, setInverseSearching] = useState(false);
  const zoomAnchorRef = useRef<{ page: number; progress: number } | null>(null);
  const restoringZoomRef = useRef(false);
  const pendingPageRef = useRef<number | null>(null);

  const attachScrollRoot = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollRoot(element);
  }, []);

  useEffect(() => {
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    let disposed = false;
    setDocument(null);
    setError(null);
    void invoke<ArrayBuffer>("read_build_pdf", { projectRoot, path })
      .then((buffer) => {
        if (disposed) return null;
        task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
        return task.promise;
      })
      .then(async (loaded) => {
        if (!loaded || disposed) return;
        setDocument(loaded);
        const first = await loaded.getPage(1);
        if (disposed) return;
        const viewport = first.getViewport({ scale: 1 });
        setBasePage({ width: viewport.width, height: viewport.height });
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
      if (task) void task.destroy();
    };
  }, [path, projectRoot, version]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (zoom === "width") return Math.max(.2, (size.width - 42) / basePage.width);
    if (zoom === "height") return Math.max(.2, (size.height - 42) / basePage.height);
    return zoom / 100;
  }, [basePage, size, zoom]);
  const pageStride = basePage.height * scale + 18;
  const firstRenderedPage = Math.max(1, currentPage - 4);
  const lastRenderedPage = Math.min(document?.numPages ?? 1, currentPage + 4);
  const zoomLabel = zoom === "width" ? "Ajustar ancho" : zoom === "height" ? "Ajustar alto" : `${zoom}%`;

  const updateCurrentPage = useCallback(() => {
    if (restoringZoomRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const estimatedPage = Math.round(Math.max(0, container.scrollTop - 24) / pageStride) + 1;
    setCurrentPage(Math.min(estimatedPage, document?.numPages ?? 1));
  }, [document?.numPages, pageStride]);

  const goToPage = (page: number) => {
    if (!document) return;
    const target = Math.min(Math.max(page, 1), document?.numPages ?? 1);
    const currentElement = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (currentElement) {
      currentElement.scrollIntoView({ behavior: "smooth", block: "start" });
      setCurrentPage(target);
      return;
    }
    pendingPageRef.current = target;
    setCurrentPage(target);
  };

  useLayoutEffect(() => {
    const target = pendingPageRef.current;
    if (!target) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-page="${target}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    pendingPageRef.current = null;
  }, [firstRenderedPage, lastRenderedPage]);

  const setZoomPreservingPage = useCallback((nextZoom: ZoomMode) => {
    const container = scrollRef.current;
    const pageElement = container?.querySelector<HTMLElement>(`[data-page="${currentPage}"]`);
    if (container && pageElement) {
      zoomAnchorRef.current = {
        page: currentPage,
        progress: Math.max(0, Math.min(1, (container.scrollTop - pageElement.offsetTop) / Math.max(1, pageElement.offsetHeight))),
      };
      restoringZoomRef.current = true;
    }
    setZoom(nextZoom);
  }, [currentPage]);

  const changeZoom = useCallback((delta: number) => {
    const numeric = typeof zoom === "number" ? zoom : Math.round(scale * 100);
    setZoomPreservingPage(Math.min(400, Math.max(25, numeric + delta)));
  }, [scale, setZoomPreservingPage, zoom]);

  const inverseSearch = useCallback((page: number, x: number, y: number) => {
    if (inverseSearching) return;
    setInverseSearching(true);
    void invoke<SourceLocation>("inverse_search", {
      projectRoot,
      pdfPath: path,
      page,
      x,
      y,
    }).then(onSourceLocation).catch((reason) => {
      onInverseSearchError(String(reason));
    }).finally(() => setInverseSearching(false));
  }, [inverseSearching, onInverseSearchError, onSourceLocation, path, projectRoot]);

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const container = scrollRef.current;
        const pageElement = container?.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`);
        if (container && pageElement) {
          container.scrollTop = pageElement.offsetTop + anchor.progress * pageElement.offsetHeight;
          setCurrentPage(anchor.page);
        }
        zoomAnchorRef.current = null;
        restoringZoomRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [scale]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".editor-pane")) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeZoom(10);
      } else if (event.key === "-") {
        event.preventDefault();
        changeZoom(-10);
      } else if (event.key === "0") {
        event.preventDefault();
        setZoomPreservingPage("width");
      } else if (event.key === "9") {
        event.preventDefault();
        setZoomPreservingPage("height");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [changeZoom, setZoomPreservingPage]);

  if (error) return <div className="pdf-load-error">No se pudo mostrar el PDF: {error}</div>;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="pdf-control-group">
          <button onClick={() => goToPage(currentPage - 1)} title="Página anterior"><ChevronUp size={17} /></button>
          <button onClick={() => goToPage(currentPage + 1)} title="Página siguiente"><ChevronDown size={17} /></button>
          <label className="page-control">
            <input
              value={currentPage}
              onChange={(event) => goToPage(Number(event.target.value) || 1)}
              aria-label="Página actual"
            />
            <span>/ {document?.numPages ?? "–"}</span>
          </label>
        </div>
        <div className="pdf-control-group">
          <button onClick={() => changeZoom(-10)} title="Alejar"><Minus size={17} /></button>
          <button onClick={() => changeZoom(10)} title="Acercar"><Plus size={17} /></button>
          <div className="zoom-menu-host">
            <button className="zoom-trigger" onClick={() => setZoomOpen((open) => !open)}>{zoomLabel}<ChevronDown size={13} /></button>
          {zoomOpen && (
            <div className="zoom-menu">
              <button onClick={() => changeZoom(10)}>Acercar <kbd>⌘ +</kbd></button>
              <button onClick={() => changeZoom(-10)}>Alejar <kbd>⌘ −</kbd></button>
              <hr />
              <button onClick={() => { setZoomPreservingPage("width"); setZoomOpen(false); }}>Ajustar al ancho <kbd>⌘ 0</kbd></button>
              <button onClick={() => { setZoomPreservingPage("height"); setZoomOpen(false); }}>Ajustar al alto <kbd>⌘ 9</kbd></button>
              <hr />
              {[50, 75, 100, 125, 150, 200, 400].map((value) => (
                <button key={value} onClick={() => { setZoomPreservingPage(value); setZoomOpen(false); }}>{value}%</button>
              ))}
            </div>
          )}
          </div>
        </div>
      </div>
      <div className="pdf-scroll" ref={attachScrollRoot} onScroll={updateCurrentPage}>
        {!document ? <div className="pdf-loading">Cargando PDF…</div> : (
          <div className="pdf-pages">
            {firstRenderedPage > 1 && (
              <div
                className="pdf-page-spacer"
                aria-hidden="true"
                style={{ height: Math.max(0, (firstRenderedPage - 1) * pageStride - 18) }}
              />
            )}
            {Array.from({ length: lastRenderedPage - firstRenderedPage + 1 }, (_, index) => (
              <PdfPage
                key={firstRenderedPage + index}
                document={document}
                pageNumber={firstRenderedPage + index}
                scale={scale}
                scrollRoot={scrollRoot}
                onInverseSearch={inverseSearch}
              />
            ))}
            {lastRenderedPage < document.numPages && (
              <div
                className="pdf-page-spacer"
                aria-hidden="true"
                style={{ height: Math.max(0, (document.numPages - lastRenderedPage) * pageStride - 18) }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
