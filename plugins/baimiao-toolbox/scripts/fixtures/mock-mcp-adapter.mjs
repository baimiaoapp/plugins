import { readFile } from 'node:fs/promises'

const MOCK_OCR_TEXT = 'Readable mock OCR text.'

const tasks = new Map()
let nextTask = 1

export function createAdapter() {
  return {
    async login() { return { authenticated: true, expires_at: '2099-01-01T00:00:00.000Z', scope: 'documents:process' } },
    async authStatus() { return { authenticated: true, expires_at: '2099-01-01T00:00:00.000Z', scope: 'documents:process' } },
    async logout() { return { authenticated: false, credentials_removed: true } },
    async submit(request) {
      if (process.env.BAIMIAO_MCP_MOCK_AUTH_REQUIRED === '1') {
        throw Object.assign(new Error('Baimiao authorization is required.'), {
          code: 'AUTH_REQUIRED',
          publicMessage: 'Baimiao authorization is required. Run login_baimiao and retry.',
        })
      }
      const task_id = `mock-task-${nextTask++}`
      tasks.set(task_id, { ...request, task_id })
      return { task_id, status: 'queued', stage: 'queued', progress: 0, message: 'Task queued.' }
    },
    async getTask({ task_id }) {
      const task = tasks.get(task_id)
      if (!task) return { task_id, status: 'failed', stage: 'completed', error: { code: 'NOT_FOUND', message: 'Mock task not found.' } }
      return {
        task_id, status: 'completed', stage: 'completed', progress: 100, message: 'Task completed.',
        result: task.operation === 'ocr'
          ? { format: 'text', text: MOCK_OCR_TEXT }
          : { format: task.options.format || 'docx' },
      }
    },
    async download({ task_id }) {
      const task = tasks.get(task_id)
      if (!task) throw new Error('Mock task not found.')
      if (task.operation === 'ocr') return Buffer.from(MOCK_OCR_TEXT, 'utf8')
      return readFile(task.input.path)
    },
  }
}
