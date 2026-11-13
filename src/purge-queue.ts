import amqp from "amqplib";
import dotenv from "dotenv";

dotenv.config();

async function purgeQueue() {
  const rabbitMqUrl = process.env.RABBITMQ_URL || "amqp://localhost";
  console.log(`Connecting to RabbitMQ at ${rabbitMqUrl}`);
  const connection = await amqp.connect(rabbitMqUrl);
  const channel = await connection.createChannel();
  const queueName = "mobile.publish";

  await channel.assertQueue(queueName, { durable: true });
  const result = await channel.purgeQueue(queueName);
  
  console.log(`Purged ${result.messageCount} messages from queue '${queueName}'`);

  setTimeout(() => {
    connection.close();
    process.exit(0);
  }, 500);
}

purgeQueue().catch((error) => {
  console.error("Error occurred while purging queue:", error);
  process.exit(1);
});
