import 'dotenv/config';

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/testdb',
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:3000',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  model: {
    claude: process.env.CLAUDE_MODEL ?? 'claude-opus-4-5',
    openai: process.env.OPENAI_MODEL ?? 'gpt-4o',
  },
  reportsDir: process.env.REPORTS_DIR ?? 'reports',
};
