ALTER TABLE "QuestionnaireAnswer" DROP CONSTRAINT "QuestionnaireAnswer_l8clOEM7NsPl_fkey";--> statement-breakpoint
ALTER TABLE "QuestionnaireAnswer" DROP CONSTRAINT "QuestionnaireAnswer_questionId_QuestionnaireQuestion_id_fkey";--> statement-breakpoint
ALTER TABLE "QuestionnaireQuestion" DROP CONSTRAINT "QuestionnaireQuestion_questionnaireId_Questionnaire_id_fkey";--> statement-breakpoint
ALTER TABLE "QuestionnaireSubmission" DROP CONSTRAINT "QuestionnaireSubmission_questionnaireId_Questionnaire_id_fkey";--> statement-breakpoint
ALTER TABLE "QuestionnaireSubmission" DROP CONSTRAINT "QuestionnaireSubmission_mha0bYFxcV7A_fkey";--> statement-breakpoint
DROP TABLE "QuestionnaireAnswer";--> statement-breakpoint
DROP TABLE "Questionnaire";--> statement-breakpoint
DROP TABLE "QuestionnaireQuestion";--> statement-breakpoint
DROP TABLE "QuestionnaireSubmission";--> statement-breakpoint
DROP TYPE "questionnaireQuestionType";--> statement-breakpoint
DROP TYPE "questionnaireSubmissionStatus";