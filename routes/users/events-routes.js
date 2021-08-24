// Import the express Router to create routes
const router = require("express").Router();
const { check } = require("express-validator");
const eventController = require("../../controllers/events-controller");
const betController = require("../../controllers/bets-controller");

router.get(
    "/list",
    eventController.listEvents
);

router.get(
    "/list/:type/:category/:count/:page/:sortby",
    eventController.filterEvents
);

router.get(
    "/list/:type/:category/:count/:page/:sortby/:searchQuery",
    eventController.filterEvents
);

router.get(
    "/chat-messages/:id",
    [
        check("id").notEmpty()
    ],
    eventController.getChatMessagesByEventId
);

router.post(
    "/bet/:id/outcomes/buy",
    [
        check("amount").isNumeric()
    ],
    betController.calculateBuyOutcome
);

router.post(
    "/bet/:id/outcomes/sell",
    [
        check("amount").isNumeric()
    ],
    betController.calculateSellOutcome
);

router.get(
    "/tags",
    eventController.getTags
)

module.exports = router;