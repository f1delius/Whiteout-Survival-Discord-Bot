const { SlashCommandBuilder } = require('discord.js');
const { handleInspectCommand, handleInspectAutocomplete } = require('../functions/Players/inspect');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inspect')
        .setDescription('Inspect a player\'s information.')
        .addStringOption(option =>
            option
                .setName('player')
                .setDescription('Player ID or nickname')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option
                .setName('game')
                .setDescription('Game to inspect')
                .setRequired(false)
                .addChoices(
                    { name: 'Whiteout Survival', value: 'wos' },
                    { name: 'Kingshot', value: 'ks' }
                )
        ),

    async execute(interaction) {
        await handleInspectCommand(interaction);
    },

    async autocomplete(interaction) {
        await handleInspectAutocomplete(interaction);
    }
};
