import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { RARITIES } from '../../types.js';
import { TIERS } from '../../domain/value.js';

const rarityChoices = RARITIES.map((r) => ({ name: TIERS[r].label, value: r }));
const showChoices = [{ name: 'All', value: 'all' }, { name: 'Owned', value: 'owned' }, { name: 'Missing', value: 'missing' }];

export const commandDefinitions = [
  new SlashCommandBuilder().setName('profile').setDescription('View a collector profile')
    .addUserOption((o) => o.setName('user').setDescription('Another collector'))
    .addBooleanOption((o) => o.setName('public').setDescription('Set whether YOUR profile is public (affects /profile and /leaderboard)')),
  new SlashCommandBuilder().setName('dex').setDescription('Browse the full card catalogue and your progress')
    .addStringOption((o) => o.setName('search').setDescription('Character or edition name').setMaxLength(64))
    .addStringOption((o) => o.setName('rarity').setDescription('Filter by rarity').addChoices(...rarityChoices))
    .addStringOption((o) => o.setName('set').setDescription('Filter by set id').setMaxLength(48))
    .addStringOption((o) => o.setName('show').setDescription('Owned / missing').addChoices(...showChoices)),
  new SlashCommandBuilder().setName('list').setDescription('List the card copies you own')
    .addStringOption((o) => o.setName('search').setDescription('Character, edition or #copy id').setMaxLength(64))
    .addStringOption((o) => o.setName('rarity').setDescription('Filter by rarity').addChoices(...rarityChoices))
    .addStringOption((o) => o.setName('sort').setDescription('Sort order').addChoices({ name: 'Newest', value: 'recent' }, { name: 'Rarest first', value: 'rarity' }, { name: 'Name', value: 'name' }))
    .addBooleanOption((o) => o.setName('locked').setDescription('Only locked'))
    .addBooleanOption((o) => o.setName('favorites').setDescription('Only favorites')),
  new SlashCommandBuilder().setName('card').setDescription('Inspect a card copy (#copy id) or a catalogue card id')
    .addStringOption((o) => o.setName('id').setDescription('Copy id like #ABCD2345, or catalogue id').setRequired(true).setAutocomplete(true))
    .addBooleanOption((o) => o.setName('lock').setDescription('Lock/unlock this copy (owned copies only)'))
    .addBooleanOption((o) => o.setName('favorite').setDescription('Favorite/unfavorite this copy (owned copies only)')),
  new SlashCommandBuilder().setName('inventory').setDescription('Your cards and resources'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim your daily pack'),
  new SlashCommandBuilder().setName('weekly').setDescription('Claim your weekly pack'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Collector rankings')
    .addStringOption((o) => o.setName('board').setDescription('Ranking').addChoices(
      { name: 'Unique cards', value: 'unique' }, { name: 'Completion %', value: 'completion' }, { name: 'Collection score', value: 'score' })),
  new SlashCommandBuilder().setName('arc').setDescription('The live arc: featured cards, your progress and a free pack')
    .addSubcommand((s) => s.setName('info').setDescription('Show the live arc'))
    .addSubcommand((s) => s.setName('pack').setDescription('Open your free arc pack (once per arc)')),
  new SlashCommandBuilder().setName('trade').setDescription('Propose a card trade')
    .addUserOption((o) => o.setName('user').setDescription('Who to trade with').setRequired(true))
    .addStringOption((o) => o.setName('offer').setDescription('Your copy ids, comma separated').setRequired(true).setMaxLength(120))
    .addStringOption((o) => o.setName('request').setDescription('Their copy ids you want, comma separated (optional)').setMaxLength(120)),
  new SlashCommandBuilder().setName('help').setDescription('How Blue Dex works'),
  new SlashCommandBuilder().setName('setup').setDescription('Choose the channel where characters appear').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addChannelOption((o) => o.setName('channel').setDescription('Spawn channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)),
  new SlashCommandBuilder().setName('settings').setDescription('View or change allowed server settings').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('view').setDescription('Show current settings'))
    .addSubcommand((s) => s.setName('spawns').setDescription('Enable or disable spawns here').addBooleanOption((o) => o.setName('enabled').setDescription('On/off').setRequired(true)))
    .addSubcommand((s) => s.setName('compact').setDescription('Use smaller card images').addBooleanOption((o) => o.setName('enabled').setDescription('On/off').setRequired(true))),
  new SlashCommandBuilder().setName('testspawn').setDescription('Diagnostic: post a TEST spawn (awards nothing)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addStringOption((o) => o.setName('character').setDescription('Operators only: force a character').setMaxLength(64)),
];
export const commandJson = () => commandDefinitions.map((c) => c.toJSON());
