import { useRef, useEffect, type Dispatch, type SetStateAction } from 'react'
import { Box, Download, RotateCcw, Share2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DummyModal } from '@/components/drive/DummyModal'
import { createPlyr, ensurePlyr } from '@/lib/plyr'
import { getPreviewKind, officeViewerUrl } from '@/lib/preview'
import type { FileItem } from '@/data/drive-data'

type FilePreviewProps = {
  open: boolean
  file: FileItem | null
  previewUrl: string
  previewError: string
  previewLoading: boolean
  previewZoom: number
  previewPanX: number
  previewPanY: number
  previewRotateX: number
  previewRotateY: number
  preview3DEnabled: boolean
  previewIsDragging: boolean
  onClose: () => void
  onDownload: () => void
  onShare: () => void
  onOpenInGoogleEditor: (file: FileItem) => void
  setPreviewZoom: Dispatch<SetStateAction<number>>
  setPreviewPanX: Dispatch<SetStateAction<number>>
  setPreviewPanY: Dispatch<SetStateAction<number>>
  setPreviewRotateX: Dispatch<SetStateAction<number>>
  setPreviewRotateY: Dispatch<SetStateAction<number>>
  setPreview3DEnabled: Dispatch<SetStateAction<boolean>>
  setPreviewIsDragging: Dispatch<SetStateAction<boolean>>
  previewIsDraggingRef: React.MutableRefObject<boolean>
  previewDragRef: React.MutableRefObject<{ startX: number; startY: number }>
  previewContainerRef: React.MutableRefObject<HTMLDivElement | null>
}

export function FilePreview({
  open,
  file,
  previewUrl,
  previewError,
  previewLoading,
  previewZoom,
  previewPanX,
  previewPanY,
  previewRotateX,
  previewRotateY,
  preview3DEnabled,
  previewIsDragging,
  onClose,
  onDownload,
  onShare,
  onOpenInGoogleEditor,
  setPreviewZoom,
  setPreviewPanX,
  setPreviewPanY,
  setPreviewRotateX,
  setPreviewRotateY,
  setPreview3DEnabled,
  setPreviewIsDragging,
  previewIsDraggingRef,
  previewDragRef,
  previewContainerRef,
}: FilePreviewProps) {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const activePreviewKind = getPreviewKind(file?.mimeType)

  useEffect(() => {
    if (!open || !file?.mimeType?.startsWith('video/') || !previewVideoRef.current) return undefined
    let disposed = false
    let player: { destroy: () => void } | null = null

    ensurePlyr().then(() => {
      if (disposed || !previewVideoRef.current) return
      player = createPlyr(previewVideoRef.current)
    }).catch(() => undefined)

    return () => {
      disposed = true
      player?.destroy()
    }
  }, [open, file?.mimeType, previewUrl])

  useEffect(() => {
    const container = previewContainerRef.current
    if (!container || activePreviewKind !== 'image') return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setPreviewZoom(prev => {
        const delta = event.deltaY > 0 ? -0.1 : 0.1
        return Math.max(0.5, Math.min(5, +(prev + delta).toFixed(2)))
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [activePreviewKind, previewUrl])

  function handlePreviewMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (previewZoom <= 1 || event.button !== 0) return
    previewIsDraggingRef.current = true
    setPreviewIsDragging(true)
    previewDragRef.current = { startX: event.clientX - previewPanX, startY: event.clientY - previewPanY }
  }

  function handlePreviewMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (previewIsDraggingRef.current) {
      setPreviewPanX(event.clientX - previewDragRef.current.startX)
      setPreviewPanY(event.clientY - previewDragRef.current.startY)
    } else if (preview3DEnabled && previewContainerRef.current) {
      const rect = previewContainerRef.current.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const maxAngle = 15
      setPreviewRotateX(((event.clientY - centerY) / (rect.height / 2)) * -maxAngle)
      setPreviewRotateY(((event.clientX - centerX) / (rect.width / 2)) * maxAngle)
    }
  }

  function handlePreviewMouseUp() {
    previewIsDraggingRef.current = false
    setPreviewIsDragging(false)
  }

  function handlePreviewMouseLeave() {
    previewIsDraggingRef.current = false
    setPreviewIsDragging(false)
    setPreviewRotateX(0)
    setPreviewRotateY(0)
  }

  function resetPreviewTransform() {
    setPreviewZoom(1)
    setPreviewPanX(0)
    setPreviewPanY(0)
    setPreviewRotateX(0)
    setPreviewRotateY(0)
    setPreview3DEnabled(false)
  }

  return (
    <DummyModal open={open} title="File Preview" description={file?.name ?? ''} onClose={onClose} className="flex h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden sm:max-w-[calc(100vw-2rem)]">
      <div ref={previewContainerRef} className="flex min-h-0 flex-1 w-full items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50" onMouseDown={handlePreviewMouseDown} onMouseMove={handlePreviewMouseMove} onMouseUp={handlePreviewMouseUp} onMouseLeave={handlePreviewMouseLeave}>
        {previewLoading ? <div className="p-6 text-center text-sm font-semibold text-slate-500">Loading preview...</div> : null}
        {previewError ? <div className="p-6 text-center text-sm text-red-600">{previewError}</div> : null}
        {!previewLoading && !previewError && activePreviewKind === 'image' && previewUrl ? (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <div
              className={`inline-block ${previewZoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
              style={{
                transform: previewZoom <= 1
                  ? `scale(${previewZoom}) rotateX(${previewRotateX}deg) rotateY(${previewRotateY}deg)`
                  : `scale(${previewZoom}) translate(${previewPanX / previewZoom}px, ${previewPanY / previewZoom}px) rotateX(${previewRotateX}deg) rotateY(${previewRotateY}deg)`,
                transformStyle: 'preserve-3d',
                backfaceVisibility: 'hidden',
                transition: previewIsDragging ? 'none' : 'transform 0.15s ease',
              }}
            >
              <img
                src={previewUrl}
                alt={file?.name ?? 'File preview'}
                className="max-h-[calc(100dvh-10rem)] max-w-full object-contain"
              />
            </div>
            <div className="absolute inset-4 pointer-events-none flex flex-col items-end justify-between">
              <div className="flex gap-2 pointer-events-auto">
                <Button variant="outline" size="sm" onClick={onDownload} title="Download">
                  <Download className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={onShare} title="Share">
                  <Share2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-col gap-2 pointer-events-auto bg-white rounded-lg border border-slate-200 p-2 shadow-lg">
                <Button variant="outline" size="sm" onClick={() => setPreviewZoom(prev => Math.max(0.5, prev - 0.1))} title="Zoom out">
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="text-xs font-semibold text-slate-600 w-12 text-center">{(previewZoom * 100).toFixed(0)}%</span>
                <Button variant="outline" size="sm" onClick={() => setPreviewZoom(prev => Math.min(5, prev + 0.1))} title="Zoom in">
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button variant={preview3DEnabled ? 'default' : 'outline'} size="sm" onClick={() => setPreview3DEnabled(prev => !prev)} title="3D">
                  <Box className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={resetPreviewTransform} title="Reset">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {!previewLoading && !previewError && activePreviewKind === 'video' && previewUrl ? <div className="shared-video-shell"><video ref={previewVideoRef} controls playsInline preload="metadata"><source src={previewUrl} type={file?.mimeType} /></video></div> : null}
        {!previewLoading && !previewError && activePreviewKind === 'document' && previewUrl ? <iframe src={previewUrl} title={file?.name ?? 'File preview'} className="h-full w-full border-0 bg-white" /> : null}
        {!previewLoading && !previewError && activePreviewKind === 'office' && previewUrl ? <iframe src={officeViewerUrl(previewUrl)} title={file?.name ?? 'File preview'} className="h-full w-full border-0 bg-white" /> : null}
        {!previewLoading && !previewError && activePreviewKind === 'google-native' && file ? <div className="grid gap-4 p-6 text-center"><p className="text-sm text-slate-500">This is a Google Docs file. Open it in Google's editor.</p><Button onClick={() => { onClose(); onOpenInGoogleEditor(file); }}>Open in Google</Button></div> : null}
        {!previewLoading && !previewError && !activePreviewKind ? <div className="p-6 text-center text-sm text-slate-500">Preview not available for this file type. Use Download instead.</div> : null}
      </div>
    </DummyModal>
  )
}
