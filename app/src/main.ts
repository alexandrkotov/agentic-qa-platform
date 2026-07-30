import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    // "http://frontend:5173" (not just "http://localhost:5173"): the
    // Dockerized discovery agent (agent-service/src/admin/server.ts) loads
    // this frontend via the compose network's service name, since
    // "localhost" from inside its own container isn't this app stack.
    // Found live: the browser's own fetch calls succeeded at the network
    // level but were blocked client-side as cross-origin once the Vite
    // Host-header check and the frontend's hardcoded API origin were both
    // already fixed. Local-only dev stack, not exposed beyond this machine.
    origin: ['http://localhost:5173', 'http://frontend:5173'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle('Agentic QA Platform API')
    .setDescription('OrderFlow — Customers, Products, Orders')
    .setVersion('0.1')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(3000);
}
bootstrap();
