# Tim's Spacetraders code

This is my code for the coding-based game spacetraders.io.
It's a multiplayer space-based game where players interact with ships and the universe solely through a REST API.
I'm enjoying challenging my coding skills by writing programs to automatically mine and trade.

One interesting thing about the game is that it completely resets every few weeks, deleting all user accounts and starting over with a newly-generated universe.
This means that the real challenge of the game is not moving ships around manually but writing programs to handle it automatically.

## Setup

I'm not sure how portable this code is, because I'm currently working on it, but here are some notes about how I set things up:

1. Clone this repo and run `yarn install`.
1. In the root of this repo, create a file named `.env`.
1. In the `.env` file, set these parameters:

   - `SPACETRADERS_PREFIX`: Your callsign, as described in https://docs.spacetraders.io/quickstart/new-game
   - `SPACETRADERS_EMAIL` (optional): Your email address
   - `SPACETRADERS_FACTION`: Your faction; teh default is COSMIC

   The file looks like this:
   ```
   SPACETRADERS_PREFIX='MYCALLSIGN'
   SPACETRADERS_EMAIL='example@example.com'
   SPACETRADERS_FACTION='GALACTIC'
   ```

   Do not share this file, because it will have your token in it soon.
1. Set up a MySQL database for the code to use. I used the database name `spacetraders` and hosted it locally.
1. Add these parameters to the `.env` file:

   - `DB_HOST`: The host name or IP address of the database. I had to use `127.0.0.1` instead of `localhost` for some reason.
   - `DB_USER`: The user name for the database.
   - `DB_PASSWORD`: The password for the database.
   - `DB_NAME`: The name of the database.

   These parameters in the file looks like this:

   ```
   DB_HOST='127.0.0.1'
   DB_USER='spacetraders'
   DB_PASSWORD='%v^5vW#SR9hwb6'
   DB_NAME='spacetraders'
   ```
1. Run `yarn newAgent` to initialize your spacetraders account and get a token, which appears in the `.env` file.
1. From here, I manually buy a mining drone with a command like this, with your starting waypoint in the `waypointSymbol` field:

   ```shell
   curl --request POST \
     --url https://api.spacetraders.io/v2/my/ships \
     --header 'Accept: application/json' \
     --header "Authorization: Bearer $SPACETRADERS_TOKEN" \
     --header 'Content-Type: application/json' \
     --data '{
     "waypointSymbol": "X1-QM77-31047C",
     "shipType": "SHIP_MINING_DRONE"
   }'
   ```
1. Then you can accept the default contract and start running the code to mine and deliver. You may need to edit code in `./src/simpleMineAndSellLoopWithContract.js`. You can also use `./src/monitorLoop.js` to send your default satellite ship around to check market prices.

More later as I play with the platform.
