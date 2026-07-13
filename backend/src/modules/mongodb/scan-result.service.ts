import { Types } from 'mongoose'
import { ScanResult, type IScanResult } from './scan-result.model.js'

export class ScanResultService {
  async bulkInsert(items: Partial<IScanResult>[]): Promise<{ inserted: number; errors: number }> {
    let inserted = 0
    let errors = 0
    const BATCH_SIZE = 1000

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE)
      try {
        const result = await ScanResult.insertMany(batch, { ordered: false })
        inserted += result.length
      } catch (err: any) {
        const partial = err?.result
        if (partial) {
          inserted += partial.nInserted ?? 0
          errors += (partial.writeErrors ?? []).filter((e: any) => e.code !== 11000).length
        } else {
          errors += batch.length
        }
      }
    }

    return { inserted, errors }
  }

  async getByMigration(migrationId: string, options: {
    parentId?: string | null
    type?: 'file' | 'folder'
    ext?: string
    search?: string
    status?: string
    page?: number
    limit?: number
  } = {}) {
    const { parentId, type, ext, search, status, page = 1, limit = 50 } = options

    const filter: Record<string, unknown> = { migrationId }

    if (parentId !== undefined) {
      filter.sourceParentId = parentId
    }

    if (type === 'file') filter.type = 'file'
    if (type === 'folder') filter.type = 'folder'
    if (status) filter.status = status
    if (ext) {
      filter.type = 'file'
      filter.extension = ext
    }
    if (search) {
      filter.name = { $regex: search, $options: 'i' }
    }

    filter.status = { $ne: 'skipped' }

    const skip = (page - 1) * limit

    const [items, total] = await Promise.all([
      ScanResult.find(filter)
        .sort({ type: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ScanResult.countDocuments(filter),
    ])

    const selectedCount = await ScanResult.countDocuments({ migrationId, status: 'selected' })
    const selectedAgg = await ScanResult.aggregate([
      { $match: { migrationId, status: 'selected' } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ])
    const selectedBytes = selectedAgg[0]?.total ?? 0n

    return {
      items: items.map((i) => ({ ...i, sizeBytes: i.size.toString() })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      selectedCount,
      selectedBytes: selectedBytes.toString(),
    }
  }

  async selectItems(migrationId: string, itemIds?: string[], selectAll?: boolean): Promise<{ selectedCount: number; selectedBytes: string }> {
    if (selectAll) {
      await ScanResult.updateMany(
        { migrationId, status: 'pending', type: 'file' },
        { $set: { status: 'selected' } }
      )
    } else if (itemIds?.length) {
      await ScanResult.updateMany(
        { _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) }, migrationId, status: 'pending' },
        { $set: { status: 'selected' } }
      )
    }

    const selectedCount = await ScanResult.countDocuments({ migrationId, status: 'selected' })
    const selectedAgg = await ScanResult.aggregate([
      { $match: { migrationId, status: 'selected' } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ])
    const selectedBytes = selectedAgg[0]?.total ?? 0n

    return { selectedCount, selectedBytes: selectedBytes.toString() }
  }

  async deselectItems(migrationId: string, itemIds?: string[], deselectAll?: boolean): Promise<{ selectedCount: number; selectedBytes: string }> {
    if (deselectAll) {
      await ScanResult.updateMany(
        { migrationId, status: 'selected' },
        { $set: { status: 'pending' } }
      )
    } else if (itemIds?.length) {
      await ScanResult.updateMany(
        { _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) }, migrationId, status: 'selected' },
        { $set: { status: 'pending' } }
      )
    }

    const selectedCount = await ScanResult.countDocuments({ migrationId, status: 'selected' })
    const selectedAgg = await ScanResult.aggregate([
      { $match: { migrationId, status: 'selected' } },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ])
    const selectedBytes = selectedAgg[0]?.total ?? 0n

    return { selectedCount, selectedBytes: selectedBytes.toString() }
  }

  async updateStatus(id: string, status: string, extra?: Partial<IScanResult>): Promise<void> {
    await ScanResult.findByIdAndUpdate(id, { $set: { status, ...extra } })
  }

  async updateStatusBySourceFileId(migrationId: string, sourceFileId: string, status: string, extra?: Partial<IScanResult>): Promise<void> {
    await ScanResult.findOneAndUpdate(
      { migrationId, sourceFileId },
      { $set: { status, ...extra } }
    )
  }

  async getSelectedItems(migrationId: string): Promise<IScanResult[]> {
    return ScanResult.find({ migrationId, status: 'selected' }).lean()
  }

  async getFailedItems(migrationId: string): Promise<IScanResult[]> {
    return ScanResult.find({ migrationId, status: 'failed' }).lean()
  }

  async resetFailedToSelected(migrationId: string): Promise<number> {
    const result = await ScanResult.updateMany(
      { migrationId, status: 'failed' },
      { $set: { status: 'selected', errorMessage: null, retryCount: 0 } }
    )
    return result.modifiedCount
  }

  async getStats(migrationId: string) {
    const stats = await ScanResult.aggregate([
      { $match: { migrationId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalSize: { $sum: '$size' },
        },
      },
    ])

    const result: Record<string, { count: number; bytes: bigint }> = {}
    for (const s of stats) {
      result[s._id] = { count: s.count, bytes: s.totalSize }
    }
    return result
  }

  async countByMigration(migrationId: string): Promise<number> {
    return ScanResult.countDocuments({ migrationId })
  }

  async getBySourceFileIds(migrationId: string, sourceFileIds: string[]): Promise<any[]> {
    return ScanResult.find({
      migrationId,
      sourceFileId: { $in: sourceFileIds }
    }).lean()
  }

  async deleteByMigration(migrationId: string): Promise<void> {
    await ScanResult.deleteMany({ migrationId })
  }

  async deleteByUser(userId: string): Promise<void> {
    await ScanResult.deleteMany({ userId })
  }

  async updateManyStatus(
    migrationId: string,
    sourceFileIds: string[],
    status: string,
    extra?: Partial<IScanResult>
  ): Promise<void> {
    await ScanResult.updateMany(
      { migrationId, sourceFileId: { $in: sourceFileIds } },
      { $set: { status, ...extra } }
    )
  }

  async fixOrphanParents(migrationId: string, orphanParentIds: string[]): Promise<void> {
    await ScanResult.updateMany(
      { migrationId, sourceParentId: { $in: orphanParentIds } },
      { $set: { sourceParentId: null } }
    )
  }
}

export const scanResultService = new ScanResultService()
