import { Schema, model } from 'mongoose'

interface IScanResult {
  migrationId: string
  userId: string
  sourceAccountId: string
  sourceFileId: string
  sourceParentId: string | null
  name: string
  type: 'file' | 'folder'
  mimeType: string
  size: number | bigint
  extension?: string
  isGoogleWorkspace: boolean
  modifiedTime?: Date
  status: 'pending' | 'selected' | 'completed' | 'failed' | 'skipped'
  targetFileId?: string
  targetFolderId?: string
  errorMessage?: string
  retryCount: number
  createdAt: Date
  updatedAt: Date
}

const scanResultSchema = new Schema<IScanResult>(
  {
    migrationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    sourceAccountId: { type: String, required: true },
    sourceFileId: { type: String, required: true },
    sourceParentId: { type: String, default: null },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ['file', 'folder'] },
    mimeType: { type: String, required: true },
    size: { type: Schema.Types.BigInt, default: 0n },
    extension: { type: String },
    isGoogleWorkspace: { type: Boolean, default: false },
    modifiedTime: { type: Date },
    status: { type: String, default: 'pending', enum: ['pending', 'selected', 'completed', 'failed', 'skipped'] },
    targetFileId: { type: String },
    targetFolderId: { type: String },
    errorMessage: { type: String },
    retryCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc: any, ret: any) => {
        if (ret.size !== undefined) ret.size = String(ret.size)
        return ret
      },
    },
  }
)

scanResultSchema.index({ migrationId: 1, status: 1 })
scanResultSchema.index({ migrationId: 1, sourceParentId: 1, status: 1 })
scanResultSchema.index({ migrationId: 1, isGoogleWorkspace: 1 })
scanResultSchema.index({ userId: 1, sourceAccountId: 1 })
scanResultSchema.index({ migrationId: 1, sourceFileId: 1 }, { unique: true })

export const ScanResult = model<IScanResult>('ScanResult', scanResultSchema)
export type { IScanResult }
