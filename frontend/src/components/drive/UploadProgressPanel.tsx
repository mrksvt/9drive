import { CheckCircle, ChevronDown, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/api'

type UploadProgressStatus = 'uploading' | 'done' | 'error' | 'partial'
type UploadProgressFile = { name: string; size: number; percent: number; status: UploadProgressStatus }
type UploadProgressState = { open: boolean; fileName: string; percent: number; status: UploadProgressStatus; files: UploadProgressFile[] }

export function UploadProgressPanel({ progress, onClose }: { progress: UploadProgressState; onClose: () => void }) {
  const title = progress.status === 'done' ? 'Upload complete' : progress.status === 'partial' ? 'Upload completed with errors' : progress.status === 'error' ? 'Upload failed' : progress.percent >= 99 ? 'Processing on server' : 'Uploading files'

  return (
    <div className="fixed inset-x-3 bottom-3 z-[70] max-h-[70dvh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[min(420px,calc(100vw-2.5rem))]">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2 font-extrabold">
          {progress.status === 'done' ? <CheckCircle className="h-5 w-5 text-emerald-500" /> : progress.status === 'partial' || progress.status === 'error' ? <X className="h-5 w-5 text-red-500" /> : <Upload className="h-5 w-5 text-blue-600" />}
          {title}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8"><ChevronDown className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="truncate font-semibold">{progress.fileName}</p>
          <span className="text-slate-500">{progress.percent}%</span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-slate-100">
          <div className={progress.status === 'error' || progress.status === 'partial' ? 'h-full rounded-full bg-red-500' : progress.status === 'done' ? 'h-full rounded-full bg-emerald-500' : 'h-full rounded-full bg-blue-600'} style={{ width: `${progress.percent}%` }} />
        </div>
        {progress.files.length > 0 ? (
          <div className="mt-4 grid max-h-64 gap-3 overflow-y-auto pr-1">
            {progress.files.map((file, index) => (
              <div key={`${file.name}-${file.size}-${index}`} className="grid gap-1 rounded-xl bg-slate-50 p-3">
                <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                  <p className="min-w-0 flex-1 truncate font-semibold" title={file.name}>{file.name}</p>
                  <span className="shrink-0 text-xs text-slate-500">{file.percent}%</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                  <span>{formatBytes(file.size)}</span>
                  <span className={file.status === 'error' ? 'font-semibold text-red-600' : file.status === 'done' ? 'font-semibold text-emerald-600' : 'font-semibold text-blue-600'}>
                    {file.status === 'error' ? 'Failed' : file.status === 'done' ? 'Done' : file.percent >= 99 ? 'Processing' : 'Uploading'}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-200">
                  <div className={file.status === 'error' ? 'h-full rounded-full bg-red-500' : file.status === 'done' ? 'h-full rounded-full bg-emerald-500' : 'h-full rounded-full bg-blue-600'} style={{ width: `${file.percent}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
