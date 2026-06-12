// Export permission constants and utilities
const { PERMISSIONS, getPermissionDescriptions } = require('./permissions');

// Export main admin management
const { createManageAdminsButton, handleManageAdminsButton } = require('./admins');

// Export back to settings functionality
const { createBackToSettingsButton, handleBackToSettingsButton } = require('../backToSettings');

// Export add admin functionality
const { handleAddAdminButton, handleAddAdminUserSelection } = require('./addAdmin');

// Export remove admin functionality
const {
    handleRemoveAdminButton,
    showRemoveAdminPage,
    handleRemoveAdminSelection,
    handleConfirmRemoveAdmin,
    handleCancelRemoveAdmin,
    handleRemoveAdminPagination
} = require('./removeAdmin');

// Export edit admin functionality
const {
    handleEditAdminButton,
    showEditAdminPage,
    handleEditAdminSelection,
    handlePermissionSelection,
    handleEditAdminPagination
} = require('./assignPermission');

// Export view admin functionality
const {
    createViewAdminButton,
    handleViewAdminButton,
    showViewAdminPage,
    handleViewAdminSelection,
    handleViewFullLogsButton,
    showFullLogsPage,
    handleViewAdminPagination,
    handleViewFullLogsPagination
} = require('./viewAdmin');

// Export transfer owner functionality
const {
    createTransferOwnerButton,
    handleTransferOwnerButton,
    handleTransferOwnerUserSelection,
    handleConfirmTransferOwner,
    handleCancelTransferOwner
} = require('./transferOnwer');

module.exports = {
    // Permission system
    PERMISSIONS,
    getPermissionDescriptions,

    // Main admin management
    createManageAdminsButton,
    handleManageAdminsButton,
    createTransferOwnerButton,
    handleTransferOwnerButton,
    handleTransferOwnerUserSelection,
    handleConfirmTransferOwner,
    handleCancelTransferOwner,

    // Navigation
    createBackToSettingsButton,
    handleBackToSettingsButton,

    // Add admin
    handleAddAdminButton,
    handleAddAdminUserSelection,

    // Remove admin
    handleRemoveAdminButton,
    showRemoveAdminPage,
    handleRemoveAdminSelection,
    handleConfirmRemoveAdmin,
    handleCancelRemoveAdmin,
    handleRemoveAdminPagination,

    // Edit admin
    handleEditAdminButton,
    showEditAdminPage,
    handleEditAdminSelection,
    handlePermissionSelection,
    handleEditAdminPagination,

    // View admin
    createViewAdminButton,
    handleViewAdminButton,
    showViewAdminPage,
    handleViewAdminSelection,
    handleViewFullLogsButton,
    showFullLogsPage,
    handleViewAdminPagination,
    handleViewFullLogsPagination
};
