function createInitialState({ storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    sessions: [],
    folders: [],
    trash: [],
    currentSession: null,
    selectedFolderId: null,
    trashOpen: false,
    editingMessageId: null,
    activePromptResolve: null,
    sidebarCollapsed: store?.getItem('sidebarCollapsed') === 'true'
  };
}

function queryElements(doc = document) {
  return {
    appShell: doc.querySelector('#appShell'),
    sidebarToggleBtn: doc.querySelector('#sidebarToggleBtn'),
    newChatBtn: doc.querySelector('#newChatBtn'),
    newFolderBtn: doc.querySelector('#newFolderBtn'),
    folderList: doc.querySelector('#folderList'),
    sessionList: doc.querySelector('#sessionList'),
    trashList: doc.querySelector('#trashList'),
    toggleTrashBtn: doc.querySelector('#toggleTrashBtn'),
    chatEyebrow: doc.querySelector('#chatEyebrow'),
    chatTitle: doc.querySelector('#chatTitle'),
    pinSelect: doc.querySelector('#pinSelect'),
    renameBotBtn: doc.querySelector('#renameBotBtn'),
    renameSessionBtn: doc.querySelector('#renameSessionBtn'),
    copyChatBtn: doc.querySelector('#copyChatBtn'),
    messages: doc.querySelector('#messages'),
    isMeCheckbox: doc.querySelector('#isMeCheckbox'),
    messageInput: doc.querySelector('#messageInput'),
    sendBtn: doc.querySelector('#sendBtn'),
    editMessageModal: doc.querySelector('#editMessageModal'),
    editMessageTextarea: doc.querySelector('#editMessageTextarea'),
    cancelEditMessageBtn: doc.querySelector('#cancelEditMessageBtn'),
    saveEditMessageBtn: doc.querySelector('#saveEditMessageBtn'),
    appPromptModal: doc.querySelector('#appPromptModal'),
    appPromptEyebrow: doc.querySelector('#appPromptEyebrow'),
    appPromptTitle: doc.querySelector('#appPromptTitle'),
    appPromptLabel: doc.querySelector('#appPromptLabel'),
    appPromptInput: doc.querySelector('#appPromptInput'),
    cancelAppPromptBtn: doc.querySelector('#cancelAppPromptBtn'),
    saveAppPromptBtn: doc.querySelector('#saveAppPromptBtn')
  };
}

function formatDate(value) {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getBotName(session) {
  const name = String(session?.aiName || '').trim();
  return name || 'AI Bot';
}

function nextMessageSender(session) {
  const messageCount = session?.messages?.length || 0;
  return messageCount % 2 === 0 ? 'me' : 'bot';
}

export { createInitialState, queryElements, formatDate, getBotName, nextMessageSender };
