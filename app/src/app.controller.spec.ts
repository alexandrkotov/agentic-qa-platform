import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return an HTML landing page linking to the API docs and the app', () => {
      const html = appController.getHello();
      expect(html).toContain('OrderFlow API');
      expect(html).toContain('href="/docs"');
      expect(html).toContain('href="http://localhost:5173"');
    });
  });
});
