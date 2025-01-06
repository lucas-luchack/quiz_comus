import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { Quiz } from "./game/Quiz.class.js";
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import config from '../config.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

// Stockage des différentes instances de quiz
const games = new Map();

// Serveur de jeu
const NB_ROUNDS = 5;
const maxPlayers = 10;
const minPlayers = 2;

app.get('/game/:gameId/:token', express.json(), (req, res) => {
    const gameId = Number(req.params.gameId);
    const token = req.params.token;

    // Vérifier si la partie existe
    if (!games.has(gameId)) {
        res.redirect('/404');
        return;
    }

    // Vérifier si le token est valide en parcourant les joueurs
    let playerFound = false;
    let playerUuid = '';
    games.get(gameId)._scores.forEach((playerData, playerName) => {
        if (playerData.token === token) {
            playerFound = true;
            playerUuid = token;
        }
    });
    if (playerFound) {
        res.sendFile(path.join(__dirname, '../public', 'index.html'));
    }
    else {
        // Rediriger vers une page 404 si l'adresse IP n'est pas trouvée
        res.redirect('/404');
    }
});

app.get('/404', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', '404.html'));
});

app.post('/game/:gameId/init', express.json(), (req, res) => {
    const gameId = Number(req.params.gameId);
    const { nbRound, players } = req.body;
    try {
        games.set(Number(gameId), new Quiz(Number(gameId), nbRound, players));
        res.status(200).json({
            success: true,
            message: 'Partie initialisée avec succès'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de l\'initialisation de la partie'
        });
    }

});

app.use(express.static('public'));

// Connexion des utilisateurs
io.on('connection', (socket) => {
    const token = socket.handshake.query.token;
    const gameId = Number(socket.handshake.query.gameId);

    // Vérifier si la partie existe
    if (!games.has(gameId)) {
        console.log(`La partie ${gameId} n'existe pas`);
        return;
    }

    console.log(`Nouveau joueur connecté pour la partie ${gameId}`);

    let currentGame = games.get(gameId);
    let pseudonyme = '';

    // Récupération du pseudonyme du joueur
    currentGame._scores.forEach((playerData, playerName) => {
        if (playerData.token === token) {
            pseudonyme = playerName;
        }
    })
    console.log(`Nom du joueur : ${pseudonyme}`);

    // Rejoindre la room de cette partie
    socket.join(gameId);
    socket.username = pseudonyme;
    socket.emit('join', pseudonyme);
    socket.emit('update leaderboard', currentGame.getLeaderboard());

    // Envoi de la manche déjà en cours (s'il y en a une)
    if (currentGame.isRoundActive) {
        console.log('envoi de la manche en cours');
        socket.emit('new round', {
            roundNumber: currentGame.currentRound,
            personality: currentGame.currentPersonality
        });
    }

    // Envoi du leaderboard à jour
    io.to(gameId).emit('update leaderboard', currentGame.getLeaderboard());

    // Annonce dans le chat
    socket.broadcast.emit('message', {
        playerName: 'System',
        msg: `${pseudonyme} a rejoint la partie !`,
    });

    // Vérification si la partie peut commencer
    if (currentGame.scores.size >= minPlayers && !currentGame.isRoundActive) {
        io.to(gameId).emit('message', {
            playerName: 'System',
            msg: 'La partie commence !'
        });
        currentGame.startNewRound(currentGame.getRandomPersonality());
        io.to(gameId).emit('new round', {
            roundNumber: currentGame.currentRound,
            personality: currentGame.currentPersonality
        });
        currentGame.startTimer(io);
    }

    // Lorsque l'utilisateur se déconnecte
    socket.on('disconnect', () => {
        console.log(`${socket.username} a quitté la partie numéro ${gameId}`);
        currentGame._usedPersonalities.delete(socket.username);  // Re-liberer le pseudonyme
        currentGame.removePlayer(socket.username); // Retirer le joueur du jeu

        // Mise à jour du leaderboard après la déconnexion
        io.to(gameId).emit('update leaderboard', currentGame.getLeaderboard());

        // Si après la déconnexion il n'y a plus assez de joueurs, on arrête la partie
        if (currentGame.scores.size < minPlayers) {
            io.to(gameId).emit('message', {
                playerName: 'System',
                msg: 'Pas assez de joueurs pour continuer la partie, elle va être fermée.'
            });
            games.delete(gameId);
        }
    });

    // Lorsque les joueurs envoient une proposition de réponse
    socket.on('guess', async ({playerName, message}) => {
        const sendDelayedMessage = (message, delay) => {
            return new Promise(resolve => {
                setTimeout(() => {
                    io.to(gameId).emit('message', message);
                    resolve();
                }, delay);
            });
        };

        const sendDelayedMessageToSocket = (message, delay) => {
            return new Promise(resolve => {
                setTimeout(() => {
                    socket.emit('message', message);
                    resolve();
                }, delay);
            });
        };

        // Envoi immédiat du message du joueur
        io.to(gameId).emit('message', {
            playerName: playerName,
            msg: message,
        });

        if (!currentGame.isRoundActive) {
            return;
        }

        if (currentGame.currentPersonality.answer.map(answer => answer.toLowerCase()).includes(message.toLowerCase())) {
            // Arrêt du round en cours pour éviter les réponses multiples
            let personality = currentGame.currentPersonality;
            currentGame.endRound();

            // Incrémentation du score
            let player = currentGame.scores.get(playerName);
            player.score++;
            currentGame.scores.set(playerName, player);

            // Envoi de messages aux joueurs
            io.to(gameId).emit('message', {
                playerName: 'System',
                msg: `Bonne réponse de ${playerName}, la personnalité était ${personality.answer[0]} !`
            });

            // Envoyer la mise à jour du leaderboard à tous les clients
            io.to(gameId).emit('update leaderboard', currentGame.getLeaderboard());

            await sendDelayedMessageToSocket({
                playerName: 'System',
                msg: `Votre score : ${currentGame.scores.get(playerName).score} point(s)`
            }, 1000);

            if (currentGame.currentRound >= currentGame.nbRounds) {
                currentGame.endGame(io);
            } else {
                setTimeout(() => {
                    currentGame.startNewRound(currentGame.getRandomPersonality());
                    io.to(gameId).emit('new round', {
                        roundNumber: currentGame.currentRound,
                        personality: currentGame.currentPersonality
                    });
                    currentGame.startTimer(io);
                }, 3000);
            }
        } else {
            // Message d'erreur
            socket.emit('message', {
                playerName: 'System',
                msg: `<p class="text-red-400">${message} : Mauvaise réponse ! Tenez bon...</p>`
            });
        }
    });
});

server.listen(config.PORT, () => {
    console.log(`Server running on port ${config.PORT}`);
});
