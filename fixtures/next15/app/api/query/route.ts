import { Pool } from 'pg'

export const dynamic = 'force-dynamic'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

async function findDeals(ids: number[]) {
  const { rows } = await pool.query('select id::int from generate_series(1, 5) as id where id in ($1, $2)', ids)
  return rows as { id: number }[]
}

export async function GET() {
  const deals = await findDeals([2, 4])

  const client = await pool.connect()
  let token: string
  try {
    const result = await client.query({ text: 'select $1::text as token', values: ['bind-secret-value'] })
    token = (result.rows[0] as { token: string }).token
  } finally {
    client.release()
  }

  const failed = await pool.query('select * from no_such_table').then(
    () => '',
    (error: Error) => error.message,
  )

  return Response.json({ deals: deals.map((deal) => deal.id), token, failed })
}
