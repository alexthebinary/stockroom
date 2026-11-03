# Settings and chart of accounts

Settings has Team, Warehouses & vendors, Accounts and Company tabs. Team lists people and their jobs; Remove deactivates a profile. People add themselves from Who's working? The avatar menu's Switch person returns there. Warehouses & vendors lists warehouses, supplier/carrier kinds and payment terms; its setup link is where more are added. Company contains company settings.

Accounts shows Account assignment and Chart of accounts. The Code, Name and type fields add a posting account. Header accounts only total children; entries use active non-header accounts. Account assignment maps the meaning of a posting line to an account. Changing an unlocked assignment affects new entries only; existing entries retain their original account.

1200 Inventory Asset is one account with two locked posting roles: inventoryOnHand (Inventory on hand) and inventoryInbound (Inventory billed, in transit). They are not separate 1201/1202 accounts. Posting an inventory bill initially debits the inbound role and credits Accounts Payable. A warehouse receipt debits the on-hand role and credits the inbound role on the same 1200 account. Those equal debit and credit lines net to zero on 1200 while reclassifying the value. That is expected, not duplicate posting. The books check uses the roles to reconcile the two parts separately.

Default accounts include 1000 Bank / Cash, 2000 Accounts Payable, 3000 Opening Balance Equity, 5000 Cost of Goods Sold, 6100 Outbound Shipping Expense, 6900 Inventory Adjustment Loss, 4900 Inventory Adjustment Gain and 6950 Vendor Return Variance. A return's difference between the vendor credit and stock cost removed uses the returnVariance role, default 6950, rather than 5000. Unlocked assignments may have been changed; inspect Account assignment for the current configuration.

Some chart accounts support accounting concepts beyond the screens currently shipped. Their presence does not imply a sales or customer invoicing screen exists. The assistant cannot edit settings, inspect assignments or create accounts.

## Test companies

To try ProfitIndex from the very first screen, make a test company: **Settings > Company > Test companies**, type a name and choose **Create and open** (or use **Switch company…** in the menu under your initial at the top right). A test company starts completely empty: setup opens, and you add yourself, a warehouse, vendors and items as a new customer would. The main company and its books are not touched.

While you are in a test company, an orange **Test company: name · Switch** button sits at the bottom of every screen; tap it to go back to the main company or to another test company. Switching companies asks who's working again. A test company can be deleted from the same list; that removes everything in it and can't be undone. The main company can't be deleted.

Feedback notes left in a test company go to the same Feedback list as everything else, marked with the test company they came from.
