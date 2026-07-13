import { Schema, model, Types } from 'mongoose'

interface IStorageProvider {
  provider: 'google_drive' | 's3'
  bucket?: string
  objectKey?: string
  providerFileId?: string
}

interface IFileMetadata {
  userId: string
  connectedAccountId: string
  name: string
  type: 'file' | 'folder'
  parentId: Types.ObjectId | null
  path: string
  extension?: string
  mimeType: string
  size: bigint
  storage: IStorageProvider
  providerFolderId?: string
  checksum?: string
  starred: boolean
  deletedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const storageSchema = new Schema<IStorageProvider>(
  {
    provider: { type: String, required: true, enum: ['google_drive', 's3'] },
    bucket: { type: String },
    objectKey: { type: String },
    providerFileId: { type: String },
  },
  { _id: false }
)

const fileMetadataSchema = new Schema<IFileMetadata>(
  {
    userId: { type: String, required: true, index: true },
    connectedAccountId: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ['file', 'folder'] },
    parentId: { type: Schema.Types.ObjectId, ref: 'FileMetadata', default: null, index: true },
    path: { type: String, required: true },
    extension: { type: String },
    mimeType: { type: String, required: true },
    size: { type: Schema.Types.BigInt, default: 0n },
    storage: { type: storageSchema, required: true },
    providerFolderId: { type: String },
    checksum: { type: String },
    starred: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc: any, ret: any) => {
        if (ret.size !== undefined) ret.size = typeof ret.size === 'bigint' ? ret.size.toString() : ret.size.toString()
        return ret
      },
    },
  }
)

fileMetadataSchema.index({ userId: 1, parentId: 1, deletedAt: 1 })
fileMetadataSchema.index({ userId: 1, path: 1 })
fileMetadataSchema.index({ userId: 1, name: 'text' })
fileMetadataSchema.index({ userId: 1, type: 1, deletedAt: 1 })
fileMetadataSchema.index({ userId: 1, starred: 1, deletedAt: 1 })
fileMetadataSchema.index({ userId: 1, updatedAt: -1 })
fileMetadataSchema.index({ 'storage.provider': 1 })
fileMetadataSchema.index({ connectedAccountId: 1 })

export const FileMetadata = model<IFileMetadata>('FileMetadata', fileMetadataSchema)
export type { IFileMetadata, IStorageProvider }
