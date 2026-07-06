import amqp from 'amqplib';
import { MobilePublishPayload } from './types';
import { BuildPipeline } from './pipeline';

export class MobileBuildWorker {
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private readonly queueName = 'mobile.publish';

  async start() {
    const rabbitMqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    console.log(`Connecting to RabbitMQ at ${rabbitMqUrl}`);

    try {
      this.connection = await amqp.connect(rabbitMqUrl);
      this.channel = await this.connection.createChannel();

      await this.channel.assertQueue(this.queueName, { durable: true });
      
      console.log(`Worker started. Listening for messages on ${this.queueName}`);

      this.channel.consume(this.queueName, async (msg) => {
        if (msg) {
          const content = msg.content.toString();
          console.log(`Received message: ${content}`);
          
          try {
            const payload = JSON.parse(content) as MobilePublishPayload;
            const pipeline = new BuildPipeline(payload);
            await pipeline.run();
            
            // Acknowledge the message if pipeline succeeded
            this.channel?.ack(msg);
          } catch (error) {
            console.error('Error processing message, nacking...', error);
            // Requeue or discard based on your retry logic
            this.channel?.nack(msg, false, false); // Nack and do not requeue for POC
          }
        }
      }, { noAck: false });

    } catch (error) {
      console.error('Failed to start MobileBuildWorker', error);
      process.exit(1);
    }
  }

  async stop() {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
    } catch (e) {
      // Ignore channel closing errors on shutdown
    }
    
    try {
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
    } catch (e) {
      // Ignore connection closing errors on shutdown
    }
  }
}
