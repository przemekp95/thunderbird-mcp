"use strict";

const accountForm = document.getElementById("accountForm");
const accountList = document.getElementById("accountList");
const accountStatus = document.getElementById("accountStatus");
const saveAccounts = document.getElementById("saveAccounts");
const addressBookForm = document.getElementById("addressBookForm");
const addressBookList = document.getElementById("addressBookList");
const addressBookStatus = document.getElementById("addressBookStatus");
const saveAddressBooks = document.getElementById("saveAddressBooks");
const directSendForm = document.getElementById("directSendForm");
const directSendEnabled = document.getElementById("directSendEnabled");
const directSendAccountList = document.getElementById("directSendAccountList");
const directSendRecipients = document.getElementById("directSendRecipients");
const directSendMaxRecipients = document.getElementById("directSendMaxRecipients");
const directSendDailyLimit = document.getElementById("directSendDailyLimit");
const directSendConfirmation = document.getElementById("directSendConfirmation");
const directSendQuota = document.getElementById("directSendQuota");
const directSendAuditPath = document.getElementById("directSendAuditPath");
const directSendStatus = document.getElementById("directSendStatus");
const saveDirectSend = document.getElementById("saveDirectSend");
const serverStatus = document.getElementById("serverStatus");
const serverPort = document.getElementById("serverPort");
const serverProfileId = document.getElementById("serverProfileId");
const serverConnectionFile = document.getElementById("serverConnectionFile");
const buildVersion = document.getElementById("buildVersion");

function setStatus(message, isError = false) {
  accountStatus.textContent = message;
  accountStatus.className = isError ? "error" : "";
}

function setAddressBookStatus(message, isError = false) {
  addressBookStatus.textContent = message;
  addressBookStatus.className = isError ? "error" : "";
}

function setDirectSendStatus(message, isError = false) {
  directSendStatus.textContent = message;
  directSendStatus.className = isError ? "error" : "";
}

function appendAccount(account) {
  const label = document.createElement("label");
  label.className = "account";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = "allowedAccount";
  checkbox.value = String(account.id);
  checkbox.checked = account.allowed === true;

  const details = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = String(account.name || account.id);
  const metadata = document.createElement("small");
  metadata.textContent = `${String(account.type || "mail")} · ${String(account.id)}`;
  details.append(name, metadata);
  label.append(checkbox, details);
  accountList.append(label);
}

function appendAddressBook(addressBook) {
  const label = document.createElement("label");
  label.className = "account";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = "allowedAddressBook";
  checkbox.value = String(addressBook.id);
  checkbox.checked = addressBook.allowed === true;

  const details = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = String(addressBook.name || addressBook.id);
  const metadata = document.createElement("small");
  metadata.textContent = addressBook.readOnly
    ? `read-only · ${String(addressBook.id)}`
    : `read/write · ${String(addressBook.id)}`;
  details.append(name, metadata);
  label.append(checkbox, details);
  addressBookList.append(label);
}

function appendDirectSendAccount(account) {
  const label = document.createElement("label");
  label.className = "account";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = "directSendAccount";
  checkbox.value = String(account.id);
  checkbox.checked = account.directSendAllowed === true;

  const details = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = String(account.name || account.id);
  const metadata = document.createElement("small");
  metadata.textContent = `${String(account.type || "mail")} · ${String(account.id)}`;
  details.append(name, metadata);
  label.append(checkbox, details);
  directSendAccountList.append(label);
}

async function loadStatus() {
  try {
    const status = await browser.mcpServer.getServerInfo();
    serverStatus.textContent = status.running ? "Running on loopback" : "Stopped";
    serverPort.textContent = status.port ? String(status.port) : "—";
    serverProfileId.textContent = String(status.profileId || "—");
    serverConnectionFile.textContent = String(status.connectionFile || "—");
    buildVersion.textContent = String(status.buildVersion || "development");
  } catch {
    serverStatus.textContent = "Unavailable";
    serverPort.textContent = "—";
    serverProfileId.textContent = "—";
    serverConnectionFile.textContent = "—";
    buildVersion.textContent = "—";
  }
}

async function loadAccounts() {
  try {
    const config = await browser.mcpServer.getAccountAccessConfig();
    accountList.replaceChildren();
    for (const account of config.accounts || []) {
      appendAccount(account);
    }
    if (!config.accounts || config.accounts.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No Thunderbird mail accounts were found.";
      accountList.append(empty);
    }
    if (config.error) {
      setStatus(config.error, true);
    } else if (config.mode === "none") {
      setStatus("All accounts are currently blocked.");
    } else {
      setStatus("Only checked accounts are accessible.");
    }
  } catch (error) {
    accountList.replaceChildren();
    const failure = document.createElement("p");
    failure.textContent = "Could not load accounts.";
    accountList.append(failure);
    setStatus(String(error?.message || error), true);
  }
}

async function loadAddressBooks() {
  try {
    const config = await browser.mcpServer.getAddressBookAccessConfig();
    addressBookList.replaceChildren();
    for (const addressBook of config.addressBooks || []) {
      appendAddressBook(addressBook);
    }
    if (!config.addressBooks || config.addressBooks.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No Thunderbird address books were found.";
      addressBookList.append(empty);
    }
    if (config.error) {
      setAddressBookStatus(config.error, true);
    } else if (config.mode === "none") {
      setAddressBookStatus("All address books are currently blocked.");
    } else {
      setAddressBookStatus("Only checked address books are accessible.");
    }
  } catch (error) {
    addressBookList.replaceChildren();
    const failure = document.createElement("p");
    failure.textContent = "Could not load address books.";
    addressBookList.append(failure);
    setAddressBookStatus(String(error?.message || error), true);
  }
}

async function loadDirectSend() {
  try {
    const config = await browser.mcpServer.getDirectSendConfig();
    directSendEnabled.checked = config.enabled === true;
    directSendRecipients.value = (config.allowedRecipients || []).join("\n");
    directSendMaxRecipients.value = String(config.maxRecipientsPerMessage || 1);
    directSendDailyLimit.value = String(config.dailyLimit || 10);
    directSendQuota.textContent =
      `${String(config.quotaUsed || 0)} used · ${String(config.quotaRemaining || 0)} remaining · ${String(config.quotaDate || "—")} UTC`;
    directSendAuditPath.textContent = String(config.auditPath || "—");
    directSendAccountList.replaceChildren();
    for (const account of config.accounts || []) {
      appendDirectSendAccount(account);
    }
    if (!config.accounts || config.accounts.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No MCP-accessible mail accounts are available.";
      directSendAccountList.append(empty);
    }
    if (config.error || config.quotaError) {
      setDirectSendStatus(config.error || config.quotaError, true);
    } else if (config.enabled) {
      setDirectSendStatus("Enabled for the checked accounts and listed recipients.");
    } else {
      setDirectSendStatus("Disabled. The direct-send MCP tool is hidden.");
    }
  } catch (error) {
    directSendAccountList.replaceChildren();
    const failure = document.createElement("p");
    failure.textContent = "Could not load direct-send policy.";
    directSendAccountList.append(failure);
    setDirectSendStatus(String(error?.message || error), true);
  }
}

accountForm.addEventListener("submit", async event => {
  event.preventDefault();
  saveAccounts.disabled = true;
  setStatus("Saving…");
  try {
    const allowedIds = Array.from(
      accountList.querySelectorAll('input[name="allowedAccount"]:checked'),
      checkbox => checkbox.value
    );
    const result = await browser.mcpServer.setAccountAccess(allowedIds);
    if (result.error) {
      setStatus(result.error, true);
    } else if (result.mode === "none") {
      setStatus("Saved. All accounts are blocked.");
    } else {
      setStatus("Saved. Only checked accounts are accessible.");
    }
  } catch (error) {
    setStatus(String(error?.message || error), true);
  } finally {
    saveAccounts.disabled = false;
  }
});

addressBookForm.addEventListener("submit", async event => {
  event.preventDefault();
  saveAddressBooks.disabled = true;
  setAddressBookStatus("Saving…");
  try {
    const allowedIds = Array.from(
      addressBookList.querySelectorAll('input[name="allowedAddressBook"]:checked'),
      checkbox => checkbox.value
    );
    const result = await browser.mcpServer.setAddressBookAccess(allowedIds);
    if (result.error) {
      setAddressBookStatus(result.error, true);
    } else if (result.mode === "none") {
      setAddressBookStatus("Saved. All address books are blocked.");
    } else {
      setAddressBookStatus("Saved. Only checked address books are accessible.");
    }
  } catch (error) {
    setAddressBookStatus(String(error?.message || error), true);
  } finally {
    saveAddressBooks.disabled = false;
  }
});

directSendForm.addEventListener("submit", async event => {
  event.preventDefault();
  saveDirectSend.disabled = true;
  setDirectSendStatus("Saving…");
  try {
    const allowedAccountIds = Array.from(
      directSendAccountList.querySelectorAll('input[name="directSendAccount"]:checked'),
      checkbox => checkbox.value
    );
    const allowedRecipients = directSendRecipients.value
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
    const result = await browser.mcpServer.setDirectSendConfig(
      directSendEnabled.checked,
      allowedAccountIds,
      allowedRecipients,
      Number(directSendMaxRecipients.value),
      Number(directSendDailyLimit.value),
      directSendConfirmation.value
    );
    if (result.error) {
      setDirectSendStatus(result.error, true);
    } else {
      directSendConfirmation.value = "";
      await loadDirectSend();
    }
  } catch (error) {
    setDirectSendStatus(String(error?.message || error), true);
  } finally {
    saveDirectSend.disabled = false;
  }
});

void loadStatus();
void loadAccounts();
void loadAddressBooks();
void loadDirectSend();
