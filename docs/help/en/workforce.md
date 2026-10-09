# Timesheets, tickets and payroll

Log working hours and absences, plan work with tickets and calculate pay, all following Slovenian employment rules.

These parts of a project need a workforce license, which covers 5 people. Larger teams add employee seats.

## Who can do what

Invite people under **Team** and give each one a role.

| Role       | What they can do                                                             |
| ---------- | ---------------------------------------------------------------------------- |
| Employee   | Log their own hours and absences and work on tickets                         |
| Supervisor | Manage everyone's timesheets, absences and tickets and run work hour reports |
| Manager    | Work with tickets, but not with timesheets                                   |

Owners and administrators can do everything a supervisor can. Employee records and pay have their own permissions, so a supervisor sees hours but not salaries.

## Log working time

Open **Timesheet**.

1. Press **+ Add time** on a day and enter the start and the end. Choose regular hours, overtime or a break.
2. Add a note or link the time to a ticket if you want.
3. At the end of the month, press **Submit month**. A supervisor then approves the timesheet or returns it with a reason.

**Fill working days** adds normal hours with a lunch break to every working day in a period that has no time yet. Slovenian public holidays are known and are skipped. An end time earlier than the start time continues into the next day.

Every change to time and absences is kept in the **Change history**, with who made it and why. The employee can read it too.

## Request and approve absences

Open **Timesheet** > **Absences**.

- An employee presses **Request absence**, chooses the type, such as vacation or sick leave, and the dates. An absence can cover whole days or part of a day.
- A supervisor approves or rejects the request and can add a note for the employee.

The vacation balance shows the days for the year, those taken, those approved ahead and those still waiting for approval.

## Run the monthly report

**Timesheet** > **Monthly report** sums the hours, overtime, holidays and absences of each person and can be downloaded as a PDF or CSV.

The gross pay estimate works out pay from those hours with the supplements for overtime, night, Sunday and holiday work and for seniority, plus meal and commute allowances. The supplements are set under **Timesheet** > **Settings**. It is an estimate, not a payslip.

## Work with tickets

**Tickets** are tasks, bug reports, feature requests and support requests. Assign a ticket to one or more people, set its priority and due date, and link it to a customer. View tickets as a list or as a board.

Time logged on a ticket appears in the timesheets. To bill it:

1. Give the ticket an hourly rate, or a fixed price that is billed once whatever the time logged.
2. Press **Invoice ticket**. You can select several tickets of the same customer to combine them on one invoice.
3. Check the draft invoice that is created and issue it.

### Attach files to a ticket

Open a ticket and press **Attach files**, or paste a screenshot anywhere on the page. A file can be up to 25 MB unless an owner or administrator changes that under **Files**, **Storage and limits**. Pictures up to 10 MB show a preview. Clicking the name of a video or a PDF opens it in the page, everything else is downloaded.

PNG and BMP pictures are stored as lossless WebP when that makes them smaller. Not a single pixel changes, only the file name ends in .webp. Photos and videos are stored as they are.

The person who uploaded a file, supervisors, administrators and owners can remove it. The ticket keeps a note of who removed it and when. Customers do not see attached files.

Attached files use **File storage**, which is separate from document storage, so a full file storage never stops you from issuing invoices. 10 GB comes with the workforce license and a file storage key adds more. Owners and administrators see every file, largest first, under **License**, **Manage files**, and can remove files there to free space.

## Chat with colleagues

**Chat** is for quick messages inside the project. Everyone except viewers, developers and cashiers can use it.

1. Press **New** and choose **New message** to write to one person, or **New group** to name a group and pick its people.
2. Write in the box at the bottom and press Enter to send. Shift and Enter starts a new line. On a phone, use the **Send** button.
3. New messages appear right away. The number next to **Chat** in the menu shows how many you have not read.

Each of your own messages has an actions menu with **Edit** and **Delete**. A deleted message is removed for everyone and its text is erased.

The person who creates a group is its admin. Under **Group details** an admin renames the group, adds and removes people and can delete any message in it. Anyone can leave a group with **Leave group**. People added later see the earlier messages.

Conversations are private. Only the people in a conversation can read it, and owners and administrators of the project cannot open other people's conversations. Message text is stored encrypted.

### Send files in chat

Press the paperclip button or paste a screenshot into the message box, then send. A message can carry up to 10 files. Pictures show a preview, videos and PDFs open in the page and everything else is downloaded.

You can delete your own attachments with the bin button next to them, and a group admin can delete any attachment in the group. The message keeps a note that the attachment was deleted and by whom.

Chat attachments use **File storage**. Owners and administrators see them under **Storage and limits** as **Chat attachment**, with the size, the sender and the date. They cannot open them or see their names, but they can remove them to free space.

To see what you sent, open **Files** and choose **My chat attachments**. The list shows each attachment and recording with its size, the conversation and the date. Remove one with **Remove**, or choose an age next to **Remove chat attachments older than** to remove all of yours that are older, for example older than 1 year. Owners and administrators have the same choice under **Storage and limits**, where it applies to everyone's chat attachments.

### Call a colleague

Open a conversation with one person and press the phone button for a voice call or the camera button for a video call, at the top of the conversation. The other person hears it ring in every tab where RabbitPay is open and can answer with or without video, or decline. The first time, the browser asks for permission to use the microphone and the camera.

The call has a row of round buttons. Hold the pointer over a button to see its name. From left to right they:

- mute your microphone, which turns the button red while you are muted,
- turn the camera on or off,
- share a window or your whole screen. Only one of you can share at a time.
- make the call fill the page,
- hang up, with the red button.

The call stays in the corner of the page while you keep working in RabbitPay. Closing the tab ends it. Sound and picture travel directly between the two browsers, not through RabbitPay.

The conversation keeps a line for every call with its length. A missed call is marked and counts as unread. If the other person is not online, they see a missed call the next time they open the chat.

### Call a group

Open a group and press the camera button at the top of the conversation to start a call. Everyone in the group then sees a highlighted button there with the number of people already in the call, which joins it, and the conversation list shows **Call in progress**. A group call does not ring.

The call shows a tile for each person. The buttons work as in a call between two people, and only one person can share a screen at a time. If your device has more than one microphone or camera, a small arrow next to that button lets you switch between them, and your choice is remembered for the next call. The small arrow next to the share button sets the quality of your shared screen: **High**, **Medium** or **Low**. Choose a lower one if your connection is slow. Press the red button to leave. The call ends when the last person leaves, and the conversation keeps a line with its length.

If a group has no camera button, the server has no media servers for group calls. Calls between two people still work.

The call has its own chat, behind the speech bubble button, for quick messages to everyone in the call. These messages are not saved. Use the conversation itself for anything that should stay.

### Schedule a meeting and invite guests

1. In **Chat**, press **New** and choose **Schedule meeting**.
2. Enter a title, the date, the start time and the length, and choose the colleagues to invite.
3. Turn on **Let guests join with a link** if people outside the team should take part.

The meeting appears in everyone's conversation list with its time. It is a group like any other, so you can write and share files in it before and after. At the agreed time, open it and start the call.

To invite a guest, open **Group details**, copy the **Guest link** and send it to them. A guest opens the link, enters their name and joins. They do not need an account. A guest can join only while the call is running, so someone from the team has to start it first, and the call ends for guests when the last team member leaves. Guests are marked as guests in the call.

An admin of the meeting can change the time, turn guest access off or press **New guest link**, which makes the old link stop working.

### Record a call

In a group call or a meeting, press the record button, the one with a dot in a circle. The recording contains everyone's voices and the shared screen. While nobody shares a screen it shows the title of the call. Everyone in the call sees who is recording, and only one person can record at a time. Tell guests before you start if your rules require their consent.

Press the same button again or leave the call to finish. The recording appears in the conversation as a video that everyone in the group can play or download. It is stored encrypted and uses **File storage**, roughly 23 MB per minute at High quality.

Recordings count toward your own storage. To change their quality, open **Files**, choose **My chat attachments** and pick **High**, **Medium** or **Low** under **Quality of the recordings you make**. Each one shows its resolution, frame rate and size per hour. With **Custom** you set the resolution, the frames per second and the video bitrate yourself, up to the limits your administrator allows. The choice is remembered in the browser you make it in.

For a single recording you can choose differently: in the call, press the small arrow next to the record button and pick a quality before you start. **Custom** uses the values you set under **My chat attachments**. This applies to that call only.

The recording is made in your browser, so keep the tab open. If the tab closes, what was recorded up to the last minute or two is still saved and appears in the conversation a few minutes later. Calls between two people cannot be recorded.

## Keep and share files

**Files** is a shared place for documents, pictures and videos. Create folders, upload files with **Upload files**, drop them onto the page or paste a screenshot.

- Click a picture, a video or a PDF to open it without downloading. Videos play in the page and you can jump to any point. Other files download when you click them.
- Every file and folder has an actions menu at the end of its row, which also opens with a right click: **Preview**, **Download**, **Share**, **Rename**, **Move** and **Delete**.
- Your own files and folders are visible only to you until you share them.
- To share, choose **Share** in the menu of any folder or any single file, at any depth. Choose **Everyone in the project** or **Chosen people**.
- Sharing a folder covers everything inside it, and people who can open a folder can also add files to it.
- What other people share with you is in **Shared with me**, grouped by the person it belongs to. Your own things stay at the top of Files.
- Sharing only adds people. If you share one subfolder or one file, the people you chose see just that item under your name in Shared with me, not the folder around it. Whoever can open the folder around it can still open the item.
- **Share**, **Rename**, **Move** and **Delete** are available to the person who added the item and to whoever made a folder above it. Deleting a folder deletes everything inside it.
- Project owners and administrators can open everything. They find other people's files in **Everyone's files**, grouped by person.

Files use the same **File storage** as ticket attachments. Owners and administrators open **Storage and limits** to see every file, largest first, and to set:

1. **Largest file in MB**, the biggest single file anyone can upload.
2. **Storage per person in MB**, how much each person can keep in Files and send as chat attachments and recordings. Leave it empty for no limit.
3. An **own limit** for one person, when someone needs more or less than the others.

A customer sees a ticket in the customer portal only after you give them access and mark the ticket as visible to them. See [Customer portal](customer-portal).

## Keep employee records

**Employees** holds the job title, employment type, pay, start date, vacation days and the personal details payroll needs, such as the tax number and bank account. The records are stored encrypted, and only people with permission to see employee records can read them. Deleting a record keeps the timesheets and absences.

## Run payroll

Open **Payroll**.

1. Press **New payroll run**, choose the month and the payment date, and press **Calculate**. RabbitPay works out gross and net pay from the month's timesheets, absences and employee records.
2. Add bonuses, tax-free refunds and deductions per person where needed, and press **Recalculate**.
3. Press **Finalize** when everything is right.

From a finalized run you get a payslip PDF for each employee, the **REK-O for eDavki** file to import and sign in eDavki, and a **Bank payment file** with one salary payment per employee to upload in your online bank.

Tax and contribution rates are kept as **Tax tables** that apply from a given month, so a change in the law is a new table and past runs stay as they were.

Severance pay, non-residents, student work, contractors and REK-O corrections are not handled yet. Check the results with your accountant before you pay.
