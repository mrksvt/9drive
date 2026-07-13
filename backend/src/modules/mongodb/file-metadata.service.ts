import { Types } from 'mongoose'
import { FileMetadata, type IFileMetadata } from './file-metadata.model.js'

export class FileMetadataService {
  async create(data: Partial<IFileMetadata>): Promise<IFileMetadata> {
    return FileMetadata.create(data)
  }

  async findById(id: string): Promise<IFileMetadata | null> {
    return FileMetadata.findById(id).lean()
  }

  async findByProviderFileId(userId: string, providerFileId: string): Promise<IFileMetadata | null> {
    return FileMetadata.findOne({
      userId,
      'storage.providerFileId': providerFileId,
      deletedAt: null,
    }).lean()
  }

  async getChildren(userId: string, parentId: string | null, options: {
    page?: number
    limit?: number
    type?: 'file' | 'folder'
    search?: string
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
  } = {}) {
    const { page = 1, limit = 50, type, search, sortBy = 'name', sortOrder = 'asc' } = options

    const filter: Record<string, unknown> = {
      userId,
      deletedAt: null,
    }

    if (parentId) {
      filter.parentId = new Types.ObjectId(parentId)
    } else {
      filter.parentId = null
    }

    if (type) filter.type = type
    if (search) filter.name = { $regex: search, $options: 'i' }

    const skip = (page - 1) * limit
    const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder === 'asc' ? 1 : -1 }

    const [items, total] = await Promise.all([
      FileMetadata.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      FileMetadata.countDocuments(filter),
    ])

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) }
  }

  async getRoot(userId: string) {
    return FileMetadata.findOne({ userId, parentId: null, deletedAt: null }).lean()
  }

  async getRecent(userId: string, limit = 10) {
    return FileMetadata.find({ userId, type: 'file', deletedAt: null })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean()
  }

  async getStarred(userId: string) {
    return FileMetadata.find({ userId, starred: true, deletedAt: null })
      .sort({ updatedAt: -1 })
      .lean()
  }

  async search(userId: string, query: string, limit = 50) {
    return FileMetadata.find({
      userId,
      deletedAt: null,
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { path: { $regex: query, $options: 'i' } },
      ],
    })
      .limit(limit)
      .lean()
  }

  async update(id: string, data: Partial<IFileMetadata>): Promise<IFileMetadata | null> {
    return FileMetadata.findByIdAndUpdate(id, { $set: data }, { new: true }).lean()
  }

  async softDelete(id: string): Promise<void> {
    await FileMetadata.findByIdAndUpdate(id, { $set: { deletedAt: new Date() } })
  }

  async moveToFolder(id: string, newParentId: string | null, newPath: string): Promise<void> {
    await FileMetadata.findByIdAndUpdate(id, {
      $set: { parentId: newParentId ? new Types.ObjectId(newParentId) : null, path: newPath },
    })
  }

  async toggleStar(id: string): Promise<IFileMetadata | null> {
    const doc = await FileMetadata.findById(id)
    if (!doc) return null
    doc.starred = !doc.starred
    await doc.save()
    return doc.toObject()
  }

  async bulkUpsert(files: Partial<IFileMetadata>[]): Promise<{ upserted: number; modified: number; errors: number }> {
    let upserted = 0
    let modified = 0
    let errors = 0
    const BATCH_SIZE = 500

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      const ops = batch.map((file) => ({
        updateOne: {
          filter: { userId: file.userId, 'storage.providerFileId': file.storage?.providerFileId },
          update: { $set: file },
          upsert: true,
        },
      }))

      try {
        const result = await FileMetadata.bulkWrite(ops as any, { ordered: false })
        upserted += result.upsertedCount
        modified += result.modifiedCount
      } catch (err: any) {
        const partial = err?.result
        if (partial) {
          upserted += partial.upsertedCount ?? 0
          modified += partial.modifiedCount ?? 0
          errors += partial.writeErrors?.length ?? 0
        } else {
          errors += batch.length
        }
      }
    }

    return { upserted, modified, errors }
  }

  async deleteByConnectedAccount(connectedAccountId: string): Promise<void> {
    await FileMetadata.updateMany(
      { connectedAccountId, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    )
  }

  async countByUser(userId: string): Promise<number> {
    return FileMetadata.countDocuments({ userId, deletedAt: null })
  }

  async totalSizeByUser(userId: string): Promise<bigint> {
    const result = await FileMetadata.aggregate([
      { $match: { userId, deletedAt: null, type: 'file' } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ])
    return result[0]?.total ?? 0n
  }
}

export const fileMetadataService = new FileMetadataService()
