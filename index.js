// Import and configure dotenv to enable use of environmental variable
const dotenv = require('dotenv');

dotenv.config();

// Import express
const express = require('express');
const http = require('http');

// Import mongoose to connect to Database
const mongoose = require('mongoose');

// Import Models from Wallfair Commons
const wallfair = require('@wallfair.io/wallfair-commons');
const { handleError } = require('./util/error-handler');

let mongoURL = process.env.DB_CONNECTION;
if (process.env.ENVIRONMENT === 'STAGING') {
  mongoURL = mongoURL.replace('admin?authSource=admin', 'wallfair?authSource=admin');
  mongoURL += '&replicaSet=wallfair&tls=true&tlsCAFile=/usr/src/app/ssl/staging.crt';
} else if (process.env.ENVIRONMENT === 'PRODUCTIVE') {
  mongoURL = mongoURL.replace('admin?authSource=admin', 'wallfair?authSource=admin');
  mongoURL += '&replicaSet=wallfair&tls=true&tlsCAFile=/usr/src/app/ssl/productive.crt';
}

// Connection to Database
async function connectMongoDB() {
  const connection = await mongoose.connect(mongoURL, {
    useUnifiedTopology: true,
    useNewUrlParser: true,
    useFindAndModify: false,
    useCreateIndex: true,
    readPreference: 'primary',
    retryWrites: true,
  });
  console.log('Connection to Mongo-DB successful');

  wallfair.initModels(connection);
  console.log('Mongoose models initialized');

  return connection;
}

async function main() {
  const mongoDBConnection = await connectMongoDB();

  // Import Admin service
  const adminService = require('./services/admin-service');
  adminService.setMongoose(mongoDBConnection);
  adminService.initialize();

  const { initBetsJobs } = require('./jobs/bets-jobs');
  initBetsJobs();

  const { initTwitchSubscribeJob } = require('./jobs/twitch-subscribe-job');
  initTwitchSubscribeJob();

  // Import Socket.io service
  const websocketService = require('./services/websocket-service');

  // Import cors
  const cors = require('cors');

  // Import middleware for jwt verification
  const passport = require('passport');
  require('./util/auth');

  // Initialise server using express
  const server = express();
  const httpServer = http.createServer(server);

  // Create socket.io server
  const socketioJwt = require('socketio-jwt');
  const { Server } = require('socket.io');
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['*'],
      credentials: true,
    },
  });

  // Create Redis pub and sub clients
  const { createClient } = require('redis');
  const pubClient = createClient({
    url: process.env.REDIS_CONNECTION,
    no_ready_check: false,
  });
  const subClient = createClient({
    url: process.env.REDIS_CONNECTION,
    no_ready_check: false,
  });

  const { init } = require('./services/notification-service');
  init(subClient);

  websocketService.setPubClient(pubClient);

  // When message arrive from Redis, disseminate to proper channels
  subClient.on('message', (channel, message) => {
    console.log(`[REDIS] Incoming : ${message}`);
    const messageObj = JSON.parse(message);

    // intercept certain messages
    // TODO how will this scale?
    if (messageObj.event === 'CASINO_REWARD') {
      // if user is receiving a casino reward, update user.amountWon
      // this notification is generated by the crash game backend
      // https://github.com/wallfair-organization/crash_game_backend/
      const userService = require('./services/user-service');
      userService.increaseAmountWon(messageObj.to, messageObj.data.reward);
    }

    io.of('/').to(messageObj.to).emit(messageObj.event, messageObj.data);
  });

  subClient.subscribe('message');
  websocketService.setIO(io);

  // Giving server ability to parse json
  server.use(passport.initialize());
  server.use(passport.session());
  adminService.buildRouter();

  server.use(adminService.getRootPath(), adminService.getRouter());
  server.use(adminService.getLoginPath(), adminService.getRouter());
  server.use(express.json({ limit: '1mb' }));
  server.use(express.urlencoded({ limit: '1mb', extended: true }));

  // Home Route
  server.get('/', (req, res) => {
    res.status(200).send({
      message: 'Blockchain meets Prediction Markets made Simple. - Wallfair.',
    });
  });

  // Import Routes
  const userRoute = require('./routes/users/users-routes');
  const secureEventRoutes = require('./routes/users/secure-events-routes');
  const secureRewardsRoutes = require('./routes/users/secure-rewards-routes');
  const eventRoutes = require('./routes/users/events-routes');
  const secureUserRoute = require('./routes/users/secure-users-routes');
  const secureBetTemplateRoute = require('./routes/users/secure-bet-template-routes');
  const twitchWebhook = require('./routes/webhooks/twitch-webhook');
  const chatRoutes = require('./routes/users/chat-routes');

  server.use(cors());

  // Using Routes
  server.use('/api/event', eventRoutes);
  server.use('/api/event', passport.authenticate('jwt', { session: false }), secureEventRoutes);

  server.use('/api/user', userRoute);
  server.use('/api/user', passport.authenticate('jwt', { session: false }), secureUserRoute);

  server.use('/api/rewards', passport.authenticate('jwt', { session: false }), secureRewardsRoutes);
  server.use(
    '/api/bet-template',
    passport.authenticate('jwt', { session: false }),
    secureBetTemplateRoute,
  );

  server.use('/webhooks/twitch/', twitchWebhook);

  app.use('/api/chat', chatRoutes);

  // Error handler middleware
  // eslint-disable-next-line no-unused-vars
  server.use((err, req, res, next) => {
    handleError(err, res);
  });

  io.use(
    socketioJwt.authorize({
      secret: process.env.JWT_KEY,
      handshake: true,
    }),
  );

  io.on('connection', (socket) => {
    const { userId } = socket.decoded_token;

    socket.on('chatMessage', (data) => {
      websocketService.handleChatMessage(socket, data, userId);
    });
    socket.on('joinRoom', (data) => websocketService.handleJoinRoom(socket, data, userId));

    socket.on('leaveRoom', (data) => websocketService.handleLeaveRoom(socket, data, userId));
  });

  // Let server run and listen
  const appServer = httpServer.listen(process.env.PORT || 8000, () => {
    const { port } = appServer.address();

    console.log(`API runs on port: ${port}`);
  });
}

main();
