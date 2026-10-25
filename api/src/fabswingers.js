// FabSwingers scraper and auto-reply service
// Login, poll messages, auto-reply 4-5 times, then pivot to Telegram

const BASE_URL = 'https://www.fabswingers.com';

// FabSwingers session state per account
const sessions = new Map();

// Conversation state: {fs_user_id: {messageCount, lastReplyAt, tgPivoted}}
const conversations = new Map();

/**
 * Login to FabSwingers and return session cookies
 */
async function login(username, password) {
  const client = await fetch(BASE_URL);
  const formAction = '/login';
  
  const res = await fetch(`${BASE_URL}${formAction}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  });

  if (!res.ok) {
    throw new Error(`FabSwingers login failed: ${res.status}`);
  }

  // Extract cookies from response
  const cookies = res.headers.get('set-cookie') || '';
  const sessionId = cookies.match(/PHPSESSID=([^;]+)/)?.[1];
  
  if (!sessionId) {
    throw new Error('No session cookie found after login');
  }

  return {
    cookies: `PHPSESSID=${sessionId}`,
    username
  };
}

/**
 * Get new messages for a user
 */
async function getMessages(session) {
  const res = await fetch(`${BASE_URL}/messages/inbox/`, {
    headers: {
      'Cookie': session.cookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status}`);
  }

  const html = await res.text();
  
  // Parse message list - FabSwingers uses a table structure
  // Each row has: user link, preview, timestamp
  const messages = [];
  
  // Regex to find message rows (adjust based on actual HTML structure)
  const messageRegex = /href="\/users\/([^"]+)"/g;
  let match;
  
  while ((match = messageRegex.exec(html)) !== null) {
    messages.push({
      username: match[1],
      unread: html.includes('class="new"') // simplistic check
    });
  }

  return messages;
}

/**
 * Send a message to a user
 */
async function sendMessage(session, toUsername, message) {
  const res = await fetch(`${BASE_URL}/messages/send/`, {
    method: 'POST',
    headers: {
      'Cookie': session.cookies,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: `to=${encodeURIComponent(toUsername)}&message=${encodeURIComponent(message)}`
  });

  if (!res.ok) {
    throw new Error(`Failed to send message: ${res.status}`);
  }

  return true;
}

/**
 * Get conversation state or initialize
 */
function getConversationState(fsUserId) {
  if (!conversations.has(fsUserId)) {
    conversations.set(fsUserId, {
      messageCount: 0,
      lastReplyAt: null,
      tgPivoted: false
    });
  }
  return conversations.get(fsUserId);
}

/**
 * Generate auto-reply based on conversation stage
 * Logs brief memory/summary to DB, not full history
 */
function generateReply(fsUserId, accountConfig) {
  const state = getConversationState(fsUserId);
  state.messageCount++;
  state.lastReplyAt = Date.now();

  const stage = state.messageCount;
  const tgUsername = accountConfig.telegram_username; // e.g. "michelle0161" (her personal TG username)

  // Generate brief summary for DB logging
  const summary = stage <= 2 
    ? "Early conversation - friendly exchange"
    : stage <= 4
    ? "Building rapport - discussing interests"
    : stage === 5
    ? "Pivoted to Telegram - shared personal username"
    : "Reminded about Telegram connection";

  // Stage 1-5: casual chat
  if (stage <= 2) {
    // Early: friendly, light
    const replies = [
      "hey there 😊 how are you doing?",
      "hi babe! thanks for the message",
      "hey! lovely to hear from you",
      "hi there! how's your day going?"
    ];
    return {
      reply: replies[Math.floor(Math.random() * replies.length)],
      summary: summary
    };
  } else if (stage <= 4) {
    // Middle: build rapport, hint at more
    const replies = [
      "you seem really nice 😊 i'd love to chat more",
      "i'm enjoying this! you're quite charming",
      "you're making me smile 😊 want to see more of me?",
      "we're getting along well! i've got some pics if you'd like to see"
    ];
    return {
      reply: replies[Math.floor(Math.random() * replies.length)],
      summary: summary
    };
  } else if (stage === 5) {
    // Pivot: introduce Telegram (her personal username, not the bot)
    state.tgPivoted = true;
    return {
      reply: `i'd love to show you some pics and chat properly 😊

add me on telegram: @${tgUsername}

it's way easier to share stuff there! 💕`,
      summary: summary
    };
  } else {
    // Already pivoted - remind
    return {
      reply: `hey! did you find me on telegram? @${tgUsername} 😊

i've got some lovely pics to share! 💕`,
      summary: summary
    };
  }
}

/**
 * Main poll handler - check for new messages and reply
 */
async function pollMessages(accountConfig, supabase) {
  const {username, password, telegram_username} = accountConfig;

  let session = sessions.get(username);
  
  // Login if no session
  if (!session) {
    try {
      session = await login(username, password);
      sessions.set(username, session);
    } catch (err) {
      console.error(`FabSwingers login error for ${username}:`, err);
      return;
    }
  }

  // Get messages
  try {
    const messages = await getMessages(session);
    
    for (const msg of messages) {
      const state = getConversationState(msg.username);
      
      // Skip if we just replied (avoid loops)
      if (state.lastReplyAt && (Date.now() - state.lastReplyAt) < 60000) {
        continue;
      }

      // Generate and send reply
      const reply = generateReply(msg.username, accountConfig);
      
      await sendMessage(session, msg.username, reply);
      
      console.log(`Replied to ${msg.username} (stage ${state.messageCount}): ${reply.substring(0, 50)}...`);
    }
  } catch (err) {
    console.error(`FabSwingers poll error for ${username}:`, err);
  }
}

/**
 * Initialize FabSwingers account from Supabase
 */
async function initFabSwingersAccount(env, accountId) {
  const sb = getSupabaseClient(env);
  
  const {data: account} = await sb
    .from('fabswingers_accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (!account) {
    throw new Error(`FabSwingers account ${accountId} not found`);
  }

  return account;
}

export {
  login,
  getMessages,
  sendMessage,
  pollMessages,
  initFabSwingersAccount,
  getConversationState
};
