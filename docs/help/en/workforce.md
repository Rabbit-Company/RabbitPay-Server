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
2. **Storage per person in MB**, how much each person can keep in Files. Leave it empty for no limit.
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
